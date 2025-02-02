/* tslint:disable: indent linebreak-style */
import * as _ from 'lodash';
import client from "../../api/cbioportalClientInstance";
import {ObservableMap, toJS, observable, reaction, action, computed, whyRun, expr, isObservableMap} from "mobx";
import {
    TypeOfCancer as CancerType, MolecularProfile, CancerStudy, SampleList, Gene,
    Sample, SampleIdentifier, SampleFilter
} from "../../api/generated/CBioPortalAPI";
import {Geneset} from "../../api/generated/CBioPortalAPIInternal";
import CancerStudyTreeData from "./CancerStudyTreeData";
import {remoteData} from "public-lib/api/remoteData";
import {labelMobxPromises, cached, debounceAsync} from "mobxpromise";
import internalClient from "../../api/cbioportalInternalClientInstance";
import {MUTCommand, SingleGeneQuery, SyntaxError} from "../../lib/oql/oql-parser";
import {parseOQLQuery} from "../../lib/oql/oqlfilter";
import memoize from "memoize-weak-decorator";
import AppConfig from 'appConfig';
import {ComponentGetsStoreContext} from "../../lib/ContextUtils";
import URL from 'url';
import {buildCBioPortalPageUrl, redirectToStudyView} from "../../api/urls";
import StudyListLogic from "./StudyListLogic";
import {stringListToIndexSet, stringListToSet} from "../../../public-lib/lib/StringUtils";
import chunkMapReduce from "shared/lib/chunkMapReduce";
import {
    MolecularProfileQueryParams,
    NonMolecularProfileQueryParams,
    nonMolecularProfileParams,
    currentQueryParams,
    molecularProfileParams,
    queryParams,
    profileAvailability,
    categorizedSamplesCount
} from "./QueryStoreUtils";
import onMobxPromise from "shared/lib/onMobxPromise";
import getOverlappingStudies from "../../lib/getOverlappingStudies";
import MolecularProfilesInStudyCache from "../../cache/MolecularProfilesInStudyCache";
import {CacheData} from "../../lib/LazyMobXCache";
import {getHierarchyData} from "shared/lib/StoreUtils";
import sessionServiceClient from "shared/api//sessionServiceInstance";
import {VirtualStudy} from "shared/model/VirtualStudy";
import {
    getGenesetsFromHierarchy,
    getVolcanoPlotMinYValue,
    getVolcanoPlotData
} from "shared/components/query/GenesetsSelectorStore";
import SampleListsInStudyCache from 'shared/cache/SampleListsInStudyCache';
import formSubmit from "../../lib/formSubmit";
import {ServerConfigHelpers} from "../../../config/config";
import getBrowserWindow from "../../lib/getBrowserWindow";
import {QueryParameter} from "../../lib/ExtendedRouterStore";
import {AlterationTypeConstants} from "../../../pages/resultsView/ResultsViewPageStore";

// interface for communicating
export type CancerStudyQueryUrlParams = {
    cancer_study_id: string,
    cancer_study_list?: string,
    genetic_profile_ids_PROFILE_MUTATION_EXTENDED: string,
    genetic_profile_ids_PROFILE_COPY_NUMBER_ALTERATION: string,
    genetic_profile_ids_PROFILE_MRNA_EXPRESSION: string,
    genetic_profile_ids_PROFILE_METHYLATION: string,
    genetic_profile_ids_PROFILE_PROTEIN_EXPRESSION: string,
    genetic_profile_ids_PROFILE_GENESET_SCORE: string,
    Z_SCORE_THRESHOLD: string,
    RPPA_SCORE_THRESHOLD: string,
    data_priority: '0' | '1' | '2',
    case_set_id: string,
    case_ids: string,
    gene_list: string,
    geneset_list?: string,
    tab_index: 'tab_download' | 'tab_visualize',
    transpose_matrix?: 'on',
    Action: 'Submit',
};

export type GeneReplacement = { alias: string, genes: Gene[] };

export const CUSTOM_CASE_LIST_ID = '-1';
export const ALL_CASES_LIST_ID = 'all';

function isInteger(str: string) {
    return Number.isInteger(Number(str));
}

export function normalizeQuery(geneQuery: string) {
    return geneQuery.trim().replace(/^\s+|\s+$/g, '').replace(/[ \+]+/g, ' ').toUpperCase();
}

export type CancerStudyQueryParams = Pick<QueryStore,
    'searchText' |
    'selectableSelectedStudyIds' |
    'dataTypePriority' |
    'selectedProfileIds' |
    'zScoreThreshold' |
    'rppaScoreThreshold' |
    'selectedSampleListId' |
    'caseIds' |
    'caseIdsMode' |
    'geneQuery' |
    'genesetQuery'>;
export const QueryParamsKeys: (keyof CancerStudyQueryParams)[] = [
    'searchText',
    'selectableSelectedStudyIds',
    'dataTypePriority',
    'selectedProfileIds',
    'zScoreThreshold',
    'rppaScoreThreshold',
    'selectedSampleListId',
    'caseIds',
    'caseIdsMode',
    'geneQuery',
    'genesetQuery',
];

type GenesetId = string;

// mobx observable
export class QueryStore {
    public initialQueryParams: {
        pathname: string,
        nonMolecularProfileParams: NonMolecularProfileQueryParams,
        molecularProfileIds: ReadonlyArray<string>
    };

    constructor(urlWithInitialParams?: string) {
        this.initialize(urlWithInitialParams);
    }

    initialize(urlWithInitialParams?: string) {

        labelMobxPromises(this);

        if (urlWithInitialParams)
            this.setParamsFromUrl(urlWithInitialParams);

        // handle local storage submission from study page (too long for url)
        let legacySubmission: any = localStorage.getItem("legacyStudySubmission");
        localStorage.removeItem("legacyStudySubmission");
        if (legacySubmission) {
            try {
                this.setParamsFromLocalStorage(JSON.parse(legacySubmission));
            } catch (ex) {
                throw("error parseing/setting legacyStudySubmission");
            }
        }

        reaction(
            () => this.allSelectedStudyIds,
            () => {
                this.studiesHaveChangedSinceInitialization = true;
            }
        );
    }

    public singlePageAppSubmitRoutine: (query: CancerStudyQueryUrlParams) => void;

    @observable studiesHaveChangedSinceInitialization: boolean = false;

    //temporary store to collect deleted studies.
    //it is used to restore virtual studies in current window
    @observable deletedVirtualStudies: string[] = [];

    //to remove a virtual study from users list
    deleteVirtualStudy(id: string) {
        sessionServiceClient.deleteVirtualStudy(id).then(
            action(() => {
                this.deletedVirtualStudies.push(id);
                //unselect if the virtual study is selected
                if (this.selectableSelectedStudyIds.indexOf(id) !== -1) {
                    this.selectableSelectedStudyIds = _.difference(this.selectableSelectedStudyIds, [id]);
                }
            }),
            action(error => {
                //TODO: how to handle if there is an error
            })
        )
    };

    //restore back a deleted virtual study, just in the current browser
    restoreVirtualStudy(id: string) {
        sessionServiceClient.addVirtualStudy(id).then(
            action(() => {
                this.deletedVirtualStudies = this.deletedVirtualStudies.filter(x => (x !== id));
            }),
            action(error => {
                //TODO: how to handle if there is an error
            })
        )
    };

    @computed get virtualStudiesMap(): { [id: string]: VirtualStudy } {
        return _.keyBy(this.userVirtualStudies.result, study => study.id);
    }

    @computed get selectedVirtualStudies(): VirtualStudy[] {
        return _.reduce(this.selectableSelectedStudies, (acc: VirtualStudy[], study) => {
            if (this.isVirtualStudy(study.studyId)) {
                if (this.virtualStudiesMap !== undefined && this.virtualStudiesMap[study.studyId]) {
                    acc.push(this.virtualStudiesMap[study.studyId])
                }
            }
            return acc;
        }, []);
    }

    //gets a list of all physical studies in the selection
    //selection can be any combination of regualr physical and virtual studies
    @computed get physicalStudyIdsInSelection(): string[] {
        // Gives selected study ids and study ids that are in selected virtual studies
        const ret: { [id: string]: boolean } = {};
        for (const studyId of this.selectableSelectedStudyIds) {
            const virtualStudy = this.virtualStudiesMap[studyId];
            if (virtualStudy) {
                virtualStudy.data.studies.forEach(study => ret[study.id] = true);
            } else {
                ret[studyId] = true;
            }
        }
        return Object.keys(ret);
    }

    copyFrom(other: CancerStudyQueryParams) {
        // download tab does not appear anywhere except home page
        this.forDownloadTab = false;

        for (let key of QueryParamsKeys)
            this[key] = other[key];
    }

    @computed get stateToSerialize() {
        return _.pick(this, QueryParamsKeys);
    }

    ////////////////////////////////////////////////////////////////////////////////
    // QUERY PARAMETERS
    ////////////////////////////////////////////////////////////////////////////////

    @observable forDownloadTab: boolean = false;

    @observable transposeDataMatrix = false;

    @observable searchText: string = '';

    @observable private _allSelectedStudyIds: ObservableMap<boolean> = observable.map<boolean>();

    @computed get allSelectedStudyIds(): string[] {
        return this._allSelectedStudyIds.keys();
    }

    @computed get selectableSelectedStudyIds(): string[] {
        let ids: string[] = this._allSelectedStudyIds.keys();
        const selectableStudies = this.selectableStudiesSet.result;
        ids = ids.reduce((obj: string[], next) => {
            if (selectableStudies[next]) {
                return obj.concat(selectableStudies[next])
            }
            return obj;

        }, []);
        ids = _.uniq(ids)
        return this.forDownloadTab ? ids.slice(-1) : ids;
    }

    set selectableSelectedStudyIds(val: string[]) {
        this._allSelectedStudyIds = observable.map(stringListToSet(val));
    }

    @action
    public setStudyIdSelected(studyId: string, selected: boolean) {
        if (this.forDownloadTab) {
            // only one can be selected at a time
            let newMap: { [studyId: string]: boolean } = {};
            if (selected) {
                newMap[studyId] = selected;
            }
            this._allSelectedStudyIds = observable.map(newMap);
        } else {
            if (selected) {
                this._allSelectedStudyIds.set(studyId, true);
            } else {
                this._allSelectedStudyIds.delete(studyId);
            }
        }
    }

    //this is to cache a selected ids in the query
    // used in when visualizing a shared another user virtual study
    private _defaultSelectedIds: ObservableMap<boolean> = observable.map<boolean>();

    @computed get defaultSelectedIds() {
        return this._defaultSelectedIds;
    }

    @observable dataTypePriority = {mutation: true, cna: true};

    // molecular profile ids
    @observable.ref private _selectedProfileIds?: ReadonlyArray<string> = undefined; // user selection
    @computed get selectedProfileIds(): ReadonlyArray<string> {
        let selectedIds;

        if (this._selectedProfileIds !== undefined) {
            selectedIds = this._selectedProfileIds;
        }
        else {
            // compute default selection
            const altTypes: MolecularProfile['molecularAlterationType'][] = [
                'MUTATION_EXTENDED',
                'COPY_NUMBER_ALTERATION',
            ];
            selectedIds = [];
            for (let altType of altTypes) {
                let profiles = this.getFilteredProfiles(altType);
                if (profiles.length)
                    selectedIds.push(profiles[0].molecularProfileId);
            }
        }

        // download tab only allows one selected profile
        if (this.forDownloadTab)
            return selectedIds.slice(0, 1);

        // query tab only allows selecting profiles with showProfileInAnalysisTab=true
        return selectedIds.filter(id => {
            let profile = this.dict_molecularProfileId_molecularProfile[id];
            return profile && profile.showProfileInAnalysisTab;
        });
    }

    set selectedProfileIds(value) {
        this._selectedProfileIds = value;
    }

    @observable zScoreThreshold: string = '2.0';

    @observable rppaScoreThreshold: string = '2.0';

    // sample list id
    @observable private _selectedSampleListId?: string = undefined; // user selection
    @computed
    public get selectedSampleListId() {
        if (this._selectedSampleListId !== undefined)
            return this._selectedSampleListId;
        return this.defaultSelectedSampleListId;
    }

    public set selectedSampleListId(value) {
        this._selectedSampleListId = value;
    }

    @observable caseIds = '';

    // this variable is used to set set custom case ids if the query is a shared virtual study query
    @observable _defaultStudySampleMap: { [id: string]: string[] } = {};

    @observable _caseIdsMode: 'sample' | 'patient' = 'sample';
    @computed get caseIdsMode() {
        return this.selectedSampleListId === CUSTOM_CASE_LIST_ID ? this._caseIdsMode : 'sample';
    }

    set caseIdsMode(value) {
        this._caseIdsMode = value;
    }

    @observable _geneQuery = '';
    get geneQuery() {
        return this._geneQuery;
    }

    set geneQuery(value: string) {
        // clear error when gene query is modified
        this.geneQueryErrorDisplayStatus = 'unfocused';
        this._geneQuery = value;
    }

    @observable _genesetQuery = '';
    get genesetQuery() {
        return this._genesetQuery.toUpperCase();
    }

    set genesetQuery(value: string) {
        // clear error when gene query is modified
        this.genesetQueryErrorDisplayStatus = 'unfocused';
        this._genesetQuery = value;
    }

    ////////////////////////////////////////////////////////////////////////////////
    // VISUAL OPTIONS
    ////////////////////////////////////////////////////////////////////////////////

    @observable geneQueryErrorDisplayStatus: 'unfocused' | 'shouldFocus' | 'focused' = 'unfocused';
    @observable genesetQueryErrorDisplayStatus: 'unfocused' | 'shouldFocus' | 'focused' = 'unfocused';
    @observable showMutSigPopup = false;
    @observable showGisticPopup = false;
    @observable showGenesetsHierarchyPopup = false;
    @observable showGenesetsVolcanoPopup = false;
    @observable priorityStudies = ServerConfigHelpers.parseConfigFormat(AppConfig.serverConfig.priority_studies);
    @observable showSelectedStudiesOnly: boolean = false;
    @observable.shallow selectedCancerTypeIds: string[] = [];
    @observable clickAgainToDeselectSingle: boolean = true;
    @observable searchExampleMessage = "";
    @observable volcanoPlotSelectedPercentile: { label: string, value: string } = {label: '75%', value: '75'};


    @observable private _maxTreeDepth: number = parseInt(AppConfig.serverConfig.skin_query_max_tree_depth!, 10);
    @computed get maxTreeDepth() {
        return (this.forDownloadTab && this._maxTreeDepth > 0) ? 1 : this._maxTreeDepth;
    }

    set maxTreeDepth(value) {
        this._maxTreeDepth = value;
    }

    @computed get userLoggedIn() {
        return getBrowserWindow().globalStores.appStore.isLoggedIn;
    }


    ////////////////////////////////////////////////////////////////////////////////
    // REMOTE DATA
    ////////////////////////////////////////////////////////////////////////////////

    readonly cancerTypes = remoteData({
        invoke: async () => {
            return client.getAllCancerTypesUsingGET({}).then((data) => {
                // all types should have parent. this is a correction for a data issue
                // where there IS a top level (parent=null) item
                return data.filter(cancerType => {
                    return cancerType.parent !== 'null';
                });
            });
        }
    }, []);

    readonly cancerStudies = remoteData(client.getAllStudiesUsingGET({projection: 'SUMMARY'}), []);
    readonly cancerStudyIdsSet = remoteData<{ [studyId: string]: boolean }>({
        await: () => [this.cancerStudies],
        invoke: async () => {
            return stringListToSet(this.cancerStudies.result.map(x => x.studyId));
        },
        default: {},
    });

    private readonly physicalStudiesIdsSet = remoteData<{ [studyId: string]: string[] }>({
        await: () => [this.cancerStudies],
        invoke: async () => {
            return this.cancerStudies.result.reduce((obj: { [studyId: string]: string[] }, item) => {
                obj[item.studyId] = [item.studyId]
                return obj
            }, {});

        },
        default: {},
    })

    private readonly virtualStudiesIdsSet = remoteData<{ [studyId: string]: string[] }>({
        await: () => [this.userVirtualStudies],
        invoke: async () => {
            return this.userVirtualStudies.result.reduce((obj: { [studyId: string]: string[] }, item) => {
                obj[item.id] = [item.id]
                return obj
            }, {});

        },
        default: {},
    })

    readonly sharedQueriedStudiesSet = remoteData<{ [studyId: string]: string[] }>({
        await: () => [this.physicalStudiesIdsSet, this.virtualStudiesIdsSet],
        invoke: async () => {
            let physicalStudiesIdsSet: { [studyId: string]: string[] } = this.physicalStudiesIdsSet.result
            let virtualStudiesIdsSet: { [studyId: string]: string[] } = this.virtualStudiesIdsSet.result

            let knownSelectableIdsSet: { [studyId: string]: string[] } = Object.assign({}, physicalStudiesIdsSet, virtualStudiesIdsSet);

            //queried id that are not selectable(this would mostly be shared virtual study)
            const unknownQueriedIds: string[] = this._defaultSelectedIds.keys().filter(id => !knownSelectableIdsSet[id]);

            let result: { [studyId: string]: string[] } = {}

            await Promise.all(unknownQueriedIds.map(id => {
                return new Promise((resolve, reject) => {
                    sessionServiceClient.getVirtualStudy(id).then((virtualStudy) => {
                        //physical study ids iin virtual study
                        let ids = virtualStudy.data.studies.map(study => study.id);
                        //unknown/unauthorized studies within virtual study
                        let unKnownPhysicalStudyIds = ids.filter(id => !physicalStudiesIdsSet[id]);
                        if (_.isEmpty(unKnownPhysicalStudyIds)) {
                            result[id] = ids;
                        }
                        resolve();
                    }).catch(() => {//error is thrown when the id is not found
                        resolve();
                    });
                });
            }));
            return result;
        },
        default: {}
    });

    private readonly physicalStudiesSet = remoteData<{ [studyId: string]: CancerStudy }>({
        await: () => [this.cancerStudies],
        invoke: async () => {
            return this.cancerStudies.result.reduce((obj: { [studyId: string]: CancerStudy }, item) => {
                obj[item.studyId] = item
                return obj
            }, {} as { [studyId: string]: CancerStudy });

        },
        default: {},
    });

    readonly userVirtualStudies = remoteData(async () => {

        if (ServerConfigHelpers.sessionServiceIsEnabled() && this.userLoggedIn) {
            try {
                const studies = await sessionServiceClient.getUserVirtualStudies();
                return studies;
            } catch (ex) {
                return [];
            }
        } else {
            return [];
        }
    }, []);

    private readonly userVirtualStudiesSet = remoteData<{ [studyId: string]: VirtualStudy }>({
        await: () => [this.userVirtualStudies],
        invoke: async () => {
            return this.userVirtualStudies.result.reduce((obj: { [studyId: string]: VirtualStudy }, item) => {
                obj[item.id] = item
                return obj
            }, {});

        },
        default: {},
    });

    private readonly sharedVirtualStudiesSet = remoteData<{ [studyId: string]: VirtualStudy }>({
        await: () => [this.physicalStudiesSet, this.userVirtualStudiesSet],
        invoke: async () => {
            let physicalStudiesIdsSet = this.physicalStudiesSet.result
            let virtualStudiesIdsSet = this.userVirtualStudiesSet.result

            let knownSelectableIds = Object.assign([], Object.keys(physicalStudiesIdsSet), Object.keys(virtualStudiesIdsSet));

            //queried id that are not selectable(this would mostly be shared virtual study)
            const unknownQueriedIds: string[] = this._defaultSelectedIds.keys().filter(id => !_.includes(knownSelectableIds, id));

            let result: { [studyId: string]: VirtualStudy } = {}

            await Promise.all(unknownQueriedIds.map(id => {
                return new Promise((resolve, reject) => {
                    sessionServiceClient.getVirtualStudy(id).then((virtualStudy) => {
                        //physical study ids iin virtual study
                        let ids = virtualStudy.data.studies.map(study => study.id);
                        //unknown/unauthorized studies within virtual study
                        let unKnownPhysicalStudyIds = ids.filter(id => !physicalStudiesIdsSet[id]);
                        if (unKnownPhysicalStudyIds.length === 0) {
                            result[id] = virtualStudy;
                        }
                        resolve();
                    }).catch(() => {//error is thrown when the id is not found
                        resolve();
                    });
                });
            }));
            return result;
        },
        default: {}
    });

    //this is mainly used when custom case set is selected
    private readonly selectedStudyToSampleSet = remoteData<{ [id: string]: { [id: string]: boolean } }>({
        await: () => [this.userVirtualStudiesSet, this.sharedVirtualStudiesSet],
        invoke: async () => {
            let studyToSampleSet: { [id: string]: { [id: string]: boolean } } = {};

            const physicalStudyIds = _.filter(this.allSelectedStudyIds, studyId => this.physicalStudiesSet.result[studyId]);

            if (this._allSelectedStudyIds.keys().length !== physicalStudyIds.length) {
                await Promise.all(_.map(physicalStudyIds, studyId => {
                    return client.getAllSamplesInStudyUsingGET({
                        studyId: studyId
                    }).then(samples => {
                        studyToSampleSet[studyId] = stringListToSet(samples.map(sample => sample.sampleId));
                    })
                }));

                const _vs = {...this.userVirtualStudiesSet.result, ...this.sharedVirtualStudiesSet.result};

                this._allSelectedStudyIds.keys().forEach(id => {
                    if (_vs[id]) {
                        let virtualStudy = _vs[id];
                        virtualStudy.data.studies.forEach(study => {
                            if (studyToSampleSet[study.id] === undefined) {
                                studyToSampleSet[study.id] = stringListToSet(study.samples)
                            }
                        });
                    }
                });
            } else {
                physicalStudyIds.forEach(studyId => {
                    studyToSampleSet[studyId] = {}
                })
            }
            return studyToSampleSet;
        },
        default: {}
    })

    public readonly selectableStudiesSet = remoteData<{ [studyId: string]: string[] }>({
        await: () => [this.physicalStudiesSet, this.selectedStudyToSampleSet],
        invoke: async () => {

            let result: { [studyId: string]: string[] } = {};

            _.each(this.physicalStudiesSet.result, (study, studyId) => {
                result[studyId] = [studyId];
            });

            _.each(this.userVirtualStudiesSet.result, (virtualStudy, studyId) => {
                result[studyId] = [studyId];
            });

            _.each(this.sharedVirtualStudiesSet.result, (virtualStudy, studyId) => {
                result[studyId] = virtualStudy.data.studies.map(study => study.id);
            });

            return result;
        },
        default: {},
        onResult: () => {
            // set case ids when case_set_id is not CUSTOM_CASE_LIST_ID(-1)
            if (this.selectedSampleListId !== CUSTOM_CASE_LIST_ID) {
                const sharedVirtualStudiesSet = this.sharedVirtualStudiesSet.result;
                let sharedIds: string[] = _.filter(this._allSelectedStudyIds.keys(), id => sharedVirtualStudiesSet[id] !== undefined)

                //this block is executed when shared virtual study is queried and case_set_id is not set
                //in this scenario we override some parameters to correctly show selected cases to user
                if (!_.isEmpty(sharedIds)) {
                    let studySampleMap = this._defaultStudySampleMap;
                    if (studySampleMap === undefined || _.isEmpty(studySampleMap)) {
                        studySampleMap = _.reduce(this.selectedStudyToSampleSet.result, (acc, next, studyId) => {
                            acc[studyId] = _.keys(next);
                            return acc;
                        }, {} as { [id: string]: string[] })
                    }

                    if (_.some(studySampleMap, (samples) => samples.length > 0)) {
                        this.setCaseIds(studySampleMap);
                    }
                } else {
                    this.caseIds = '';
                }
            }
        }
    });

    @action setCaseIds(studySampleMap: { [id: string]: string[] }) {
        this.selectedSampleListId = CUSTOM_CASE_LIST_ID;
        this.caseIdsMode = 'sample';
        this.caseIds = _.flatten<string>(Object.keys(studySampleMap).map(studyId => {
            return studySampleMap[studyId].map((sampleId: string) => `${studyId}:${sampleId}`);
        })).join("\n");
    }

    // get all selected ids(that are set) that are not selectable in the cancer tree
    // this may be any unknow and unauthorized studies trying to query
    readonly unknownStudyIds = remoteData<string[]>({
        await: () => [this.selectableStudiesSet],
        invoke: async () => {
            const _selectableStudiesSet = this.selectableStudiesSet.result;
            let ids: string[] = this._allSelectedStudyIds.keys();
            return ids.filter(id => !(id in _selectableStudiesSet));
        },
        default: []
    });


    readonly molecularProfiles = remoteData<MolecularProfile[]>({
        invoke: async () => {
            if (this.physicalStudyIdsInSelection.length === 1) {
                return await client.getAllMolecularProfilesInStudyUsingGET({
                    studyId: this.physicalStudyIdsInSelection[0]
                });
            } else {
                return [];
            }
        },
        default: [],
        onResult: () => {
            if (!this.initiallySelected.profileIds || this.studiesHaveChangedSinceInitialization) {
                this._selectedProfileIds = undefined;
            }
        }
    });

    readonly molecularProfilesInSelectedStudies = remoteData<MolecularProfile[]>({
        invoke: async () => {
            const profiles: CacheData<MolecularProfile[], string>[] =
                await this.molecularProfilesInStudyCache.getPromise(this.physicalStudyIdsInSelection, true);
            return _.flatten(profiles.map(d => (d.data ? d.data : [])));
        },
        default: []
    });

    readonly sampleListInSelectedStudies = remoteData<SampleList[]>({
        await: () => {
            return this.physicalStudyIdsInSelection.map(studyId => {
                return this.sampleListsInStudyCache.get(studyId)
            })
        },
        invoke: async () => {
            return _.reduce(this.physicalStudyIdsInSelection, (acc: SampleList[], studyId) => {
                let sampleLists = this.sampleListsInStudyCache.get(studyId).result
                if (!_.isUndefined(sampleLists)) {
                    acc = acc.concat(sampleLists)
                }
                return acc;
            }, []);
        },
        default: [],
        onResult: () => {
            if (!this.initiallySelected.sampleListId || this.studiesHaveChangedSinceInitialization) {
                this._selectedSampleListId = undefined;
            }
        }
    });

    readonly profileAvailability = remoteData<{ mutation: boolean, cna: boolean }>({
        await: () => [this.molecularProfilesInSelectedStudies],
        invoke: () => {
            return Promise.resolve(profileAvailability(this.molecularProfilesInSelectedStudies.result!));
        },
        default: {
            mutation: false,
            cna: false
        },
        onResult: () => {
            if (!this.initiallySelected.sampleListId || this.studiesHaveChangedSinceInitialization) {
                this.dataTypePriority = profileAvailability(this.molecularProfilesInSelectedStudies.result!)
            }
        }
    });

    readonly profiledSamplesCount = remoteData<{ w_mut: number, w_cna: number, w_mut_cna: number, all: number }>({
        await: () => [this.sampleListInSelectedStudies],
        invoke: async () => {
            return categorizedSamplesCount(
                this.sampleListInSelectedStudies.result,
                this.selectableSelectedStudyIds,
                this.selectedVirtualStudies);
        },
        default: {
            w_mut: 0,
            w_cna: 0,
            w_mut_cna: 0,
            all: 0
        }
    });

    readonly sampleLists = remoteData({
        invoke: async () => {
            if (!this.isSingleNonVirtualStudySelected) {
                return [];
            }
            this.sampleListsInStudyCache.get(this.selectableSelectedStudyIds[0]).result!
            let sampleLists = await this.sampleListsInStudyCache.get(this.selectableSelectedStudyIds[0]).result!
            return _.sortBy(sampleLists, sampleList => sampleList.name);
        },
        default: [],
        onResult: () => {
            if (!this.initiallySelected.sampleListId || this.studiesHaveChangedSinceInitialization) {
                this._selectedSampleListId = undefined;
            }
        }
    });

    readonly mutSigForSingleStudy = remoteData({
        invoke: async () => {
            if (!this.isSingleNonVirtualStudySelected) {
                return [];
            }
            return await internalClient.getSignificantlyMutatedGenesUsingGET({
                studyId: this.selectableSelectedStudyIds[0]
            });
        },
        default: []
    });

    readonly gisticForSingleStudy = remoteData({
        invoke: async () => {
            if (!this.isSingleNonVirtualStudySelected) {
                return [];
            }
            return await internalClient.getSignificantCopyNumberRegionsUsingGET({
                studyId: this.selectableSelectedStudyIds[0]
            });
        },
        default: []
    });

    readonly genes = remoteData({
        invoke: () => this.invokeGenesLater(this.geneIds),
        default: {found: [], suggestions: []}
    });

    readonly genesets = remoteData({
        invoke: () => this.invokeGenesetsLater(this.genesetIds),
        default: {found: [], invalid: []}
    });

    private invokeGenesLater = debounceAsync(
        async (geneIds: string[]): Promise<{ found: Gene[], suggestions: GeneReplacement[] }> => {
            let [entrezIds, hugoIds] = _.partition(_.uniq(geneIds), isInteger);

            let getEntrezResults = async () => {
                let found: Gene[];
                if (entrezIds.length)
                    found = await client.fetchGenesUsingPOST({geneIdType: "ENTREZ_GENE_ID", geneIds: entrezIds});
                else
                    found = [];
                let missingIds = _.difference(entrezIds, found.map(gene => gene.entrezGeneId + ''));
                let removals = missingIds.map(entrezId => ({alias: entrezId, genes: []}));
                let replacements = found.map(gene => ({alias: gene.entrezGeneId + '', genes: [gene]}));
                let suggestions = [...removals, ...replacements];
                return {found, suggestions};
            };

            let getHugoResults = async () => {
                let found: Gene[];
                if (hugoIds.length)
                    found = await client.fetchGenesUsingPOST({geneIdType: "HUGO_GENE_SYMBOL", geneIds: hugoIds});
                else
                    found = [];
                let missingIds = _.difference(hugoIds, found.map(gene => gene.hugoGeneSymbol));
                let suggestions = await Promise.all(missingIds.map(alias => this.getGeneSuggestions(alias)));
                return {found, suggestions};
            };

            let [entrezResults, hugoResults] = await Promise.all([getEntrezResults(), getHugoResults()]);
            return {
                found: [...entrezResults.found, ...hugoResults.found],
                suggestions: [...entrezResults.suggestions, ...hugoResults.suggestions]
            };
        },
        500
    );

    private invokeGenesetsLater = debounceAsync(
        async (genesetIds: string[]): Promise<{ found: Geneset[], invalid: string[] }> => {
            if (genesetIds.length > 0) {
                const found = await internalClient.fetchGenesetsUsingPOST({genesetIds: genesetIds});
                const invalid = _.difference(genesetIds, found.map(geneset => geneset.genesetId));
                return {found, invalid};
            } else {
                return Promise.resolve({found: [], invalid: []});
            }
        },
        500
    );

    @memoize
    async getGeneSuggestions(alias: string): Promise<GeneReplacement> {
        return {
            alias,
            genes: await client.getAllGenesUsingGET({alias})
        };
    }

    @memoize
    getSamplesForStudyAndPatient(studyId: string, patientId: string) {
        return client.getAllSamplesOfPatientInStudyUsingGET({studyId, patientId})
            .then(
                samples => ({studyId, patientId, samples, error: undefined}),
                error => ({studyId, patientId, samples: [] as Sample[], error})
            );
    }

    asyncCustomCaseSet = remoteData<{ sampleId: string, studyId: string }[]>({
        invoke: async () => {
            if (this.selectedSampleListId !== CUSTOM_CASE_LIST_ID || (this.caseIds.trim().length === 0))
                return [];
            return this.invokeCustomCaseSetLater({
                isVirtualStudySelected: this.isVirtualStudySelected,
                caseIds: this.caseIds,
                caseIdsMode: this.caseIdsMode,
            })
        },
        default: []
    });

    private invokeCustomCaseSetLater = debounceAsync(
        async (params: Pick<this, 'isVirtualStudySelected' | 'caseIds' | 'caseIdsMode'>) => {
            let singleSelectedStudyId = '';
            if (this.isSingleNonVirtualStudySelected) {
                singleSelectedStudyId = this.selectableSelectedStudyIds[0];
            }
            let entities = params.caseIds.trim().split(/\s+/g);
            const studyIdsInSelectionSet = stringListToSet(this.physicalStudyIdsInSelection);
            const cases: { id: string, study: string }[] = entities.map(entity => {
                let splitEntity = entity.split(':');
                if (splitEntity.length === 1) {
                    // no study specified
                    if (singleSelectedStudyId) {
                        // if only one study selected, fill it in
                        return {
                            id: entity,
                            study: singleSelectedStudyId
                        };
                    } else {
                        // otherwise, throw error
                        throw new Error(`No study specified for ${this.caseIdsMode} id: ${entity}, and more than one study selected for query.`);
                    }
                } else if (splitEntity.length === 2) {
                    const study = splitEntity[0];
                    const id = splitEntity[1];
                    if (!studyIdsInSelectionSet[study]) {
                        let virtualStudyMessagePart = '';
                        if (this.isVirtualStudySelected) {
                            virtualStudyMessagePart = ', nor part of a selected Saved Study';
                        }
                        throw new Error(`Study ${study} is not selected${virtualStudyMessagePart}.`);
                    }
                    return {
                        id,
                        study
                    };
                } else {
                    throw new Error(`Input error for entity: ${entity}.`);
                }
            });
            const caseOrder = stringListToIndexSet(cases.map(x => `${x.study}:${x.id}`));
            let retSamples: { sampleId: string, studyId: string }[] = [];
            const validIds: { [studyColonId: string]: boolean } = {};
            let invalidIds: { id: string, study: string }[] = [];
            if (params.caseIdsMode === 'sample') {
                const sampleIdentifiers = cases.map(c => ({studyId: c.study, sampleId: c.id}));
                if (sampleIdentifiers.length) {
                    let sampleObjs = await chunkMapReduce(sampleIdentifiers, chunk => client.fetchSamplesUsingPOST({
                        sampleFilter: {
                            sampleIdentifiers: chunk
                        } as SampleFilter,
                        projection: "SUMMARY"
                    }), 990);
                    // sort by input order
                    sampleObjs = _.sortBy(sampleObjs, sampleObj => caseOrder[`${sampleObj.studyId}:${sampleObj.sampleId}`]);

                    for (const sample of sampleObjs) {
                        retSamples.push({studyId: sample.studyId, sampleId: sample.sampleId});
                        validIds[`${sample.studyId}:${sample.sampleId}`] = true;
                    }
                }
            }
            else {
                // convert patient IDs to sample IDs
                const samplesPromises = cases.map(c => this.getSamplesForStudyAndPatient(c.study, c.id));
                let result: { studyId: string, patientId: string, samples: Sample[], error?: Error }[] = await Promise.all(samplesPromises);
                // sort by input order
                result = _.sortBy(result, obj => caseOrder[`${obj.studyId}:${obj.patientId}`]);

                for (const {studyId, patientId, samples, error} of result) {
                    if (!error && samples.length) {
                        retSamples = retSamples.concat(samples.map(sample => {
                            validIds[`${sample.studyId}:${sample.patientId}`] = true;
                            return {
                                studyId: sample.studyId,
                                sampleId: sample.sampleId
                            };
                        }));
                    }
                }
            }

            invalidIds = invalidIds.concat(cases.filter(x => (!validIds[`${x.study}:${x.id}`])));

            let selectedStudyToSampleSet = this.selectedStudyToSampleSet.result;

            //check if the valid samples are in selectable samples set
            //this is when a virtual study(which would have subset of samples) is selected
            retSamples.forEach(obj => {
                //if selectedStudyToSampleSet[obj.studyId] is empty indicates that all samples in that study are selectable
                if (selectedStudyToSampleSet[obj.studyId] && !_.isEmpty(selectedStudyToSampleSet[obj.studyId])) {
                    if (!selectedStudyToSampleSet[obj.studyId][obj.sampleId]) {
                        invalidIds.push({id: obj.sampleId, study: obj.studyId})
                    }
                }
            });

            if (invalidIds.length) {
                if (this.isSingleNonVirtualStudySelected) {
                    throw new Error(
                        `Invalid ${
                            params.caseIdsMode
                            }${
                            invalidIds.length > 1 ? 's' : ''
                            } for the selected cancer study: ${
                            invalidIds.map(x => x.id).join(', ')
                            }`
                    );
                } else {
                    throw new Error(
                        `Invalid (study, ${
                            params.caseIdsMode
                            }) pair${
                            invalidIds.length > 1 ? 's' : ''
                            }: ${invalidIds.map(x => `(${x.study}, ${x.id})`).join(', ')}
						`
                    );
                }
            }

            return retSamples;
        },
        500
    );


    ////////////////////////////////////////////////////////////////////////////////
    // DERIVED DATA
    ////////////////////////////////////////////////////////////////////////////////

    // CANCER STUDY

    @cached get treeData() {
        return new CancerStudyTreeData({
            cancerTypes: this.cancerTypes.result,
            studies: this.cancerStudies.result,
            priorityStudies: this.priorityStudies,
            virtualStudies: this.forDownloadTab ? [] : this.userVirtualStudies.result,
            maxTreeDepth: this.maxTreeDepth
        });
    }

    readonly studyListLogic = new StudyListLogic(this);

    @computed get selectedCancerTypes() {
        return this.selectedCancerTypeIds.map(id => this.treeData.map_cancerTypeId_cancerType.get(id) as CancerType).filter(_.identity);
    }

    @computed get selectableSelectedStudies() {
        return this.selectableSelectedStudyIds.map(id => this.treeData.map_studyId_cancerStudy.get(id) as CancerStudy).filter(_.identity);
    }

    public isVirtualStudy(studyId: string): boolean {
        // if the study id doesn't correspond to one in this.cancerStudies, then its a virtual Study
        return !this.cancerStudyIdsSet.result[studyId];
    }

    public isDeletedVirtualStudy(studyId: string): boolean {
        if (this.isVirtualStudy(studyId) && this.deletedVirtualStudies.indexOf(studyId) > -1) {
            return true;
        }
        return false;
    }

    private isSingleStudySelected(shouldBeVirtualStudy: boolean) {
        if (this.selectableSelectedStudyIds.length !== 1) {
            return false;
        }
        const selectedStudyId = this.selectableSelectedStudyIds[0];
        return (this.isVirtualStudy(selectedStudyId) === shouldBeVirtualStudy);
    }

    @computed
    public get isSingleVirtualStudySelected() {
        return this.isSingleStudySelected(true);
    }

    @computed
    public get isSingleNonVirtualStudySelected() {
        return this.isSingleStudySelected(false);
    }

    @computed
    public get getOverlappingStudiesMap() {
        const overlappingStudyGroups = getOverlappingStudies(this.selectableSelectedStudies);
        return _.chain(overlappingStudyGroups)
            .flatten()
            .keyBy((study: CancerStudy) => study.studyId)
            .value();
    }

    @computed
    public get isVirtualStudySelected() {
        let ret = false;
        for (const studyId of this.selectableSelectedStudyIds) {
            if (this.virtualStudiesMap[studyId]) {
                ret = true;
                break;
            }
        }
        return ret;
    }

    @computed
    public get isVirtualStudyQuery() {
        if (this.selectableSelectedStudyIds.length === 0) {
            return false;
        } else if (this.selectableSelectedStudyIds.length > 1) {
            return true;
        } else {
            return this.isSingleVirtualStudySelected;
        }
    }

    // DATA TYPE PRIORITY

    private calculateDataTypePriorityCode(dataTypePriority: { mutation: boolean, cna: boolean }): '0' | '1' | '2' {
        let {mutation, cna} = dataTypePriority;
        if (mutation && cna)
            return '0';
        if (mutation)
            return '1';
        if (cna)
            return '2';

        return '0';
    }

    set dataTypePriorityCode(code: '0' | '1' | '2') {
        switch (code) {
            default:
            case '0':
                this.dataTypePriority = {mutation: true, cna: true};
                break;
            case '1':
                this.dataTypePriority = {mutation: true, cna: false};
                break;
            case '2':
                this.dataTypePriority = {mutation: false, cna: true};
                break;
        }
    }

    @computed get dataTypePriorityCode(): '0' | '1' | '2' {
        return this.calculateDataTypePriorityCode(this.dataTypePriority);
    }

    // MOLECULAR PROFILE

    @computed get dict_molecularProfileId_molecularProfile(): _.Dictionary<MolecularProfile | undefined> {
        return _.keyBy(this.molecularProfiles.result, profile => profile.molecularProfileId);
    }

    getFilteredProfiles(molecularAlterationType: MolecularProfile['molecularAlterationType']) {
        return this.molecularProfiles.result.filter(profile => {
            if (profile.molecularAlterationType != molecularAlterationType)
                return false;

            return profile.showProfileInAnalysisTab || this.forDownloadTab;
        });
    }

    isProfileSelected(molecularProfileId: string) {
        return _.includes(this.selectedProfileIds, molecularProfileId);
    }

    getSelectedProfileIdFromMolecularAlterationType(molecularAlterationType: MolecularProfile['molecularAlterationType'], selectedProfileIds?: ReadonlyArray<string>): string {
        for (let profileId of (selectedProfileIds || this.selectedProfileIds)) {
            let profile = this.dict_molecularProfileId_molecularProfile[profileId];
            if (profile && profile.molecularAlterationType === molecularAlterationType)
                return profile.molecularProfileId;
        }
        return '';
    }

    get isGenesetProfileSelected() {
        let result = false;
        if (this.getFilteredProfiles("GENESET_SCORE")[0]) {
            for (const selectedProfileId in this.selectedProfileIds) {
                if (this.selectedProfileIds[selectedProfileId] === this.getFilteredProfiles("GENESET_SCORE")[0].molecularProfileId) {
                    result = true;
                }
            }
        }
        return result;
    }

    // SAMPLE LIST

    @computed get defaultSelectedSampleListId() {
        if (this.isVirtualStudyQuery) {
            return ALL_CASES_LIST_ID;
        }

        if (this.selectableSelectedStudyIds.length !== 1)
            return undefined;

        let studyId = this.selectableSelectedStudyIds[0];
        let mutSelect = this.getSelectedProfileIdFromMolecularAlterationType('MUTATION_EXTENDED');
        let cnaSelect = this.getSelectedProfileIdFromMolecularAlterationType('COPY_NUMBER_ALTERATION');
        let expSelect = this.getSelectedProfileIdFromMolecularAlterationType('MRNA_EXPRESSION');
        let rppaSelect = this.getSelectedProfileIdFromMolecularAlterationType('PROTEIN_LEVEL');
        let sampleListId = studyId + "_all";

        if (mutSelect && cnaSelect && !expSelect && !rppaSelect)
            sampleListId = studyId + "_cnaseq";
        else if (mutSelect && !cnaSelect && !expSelect && !rppaSelect)
            sampleListId = studyId + "_sequenced";
        else if (!mutSelect && cnaSelect && !expSelect && !rppaSelect)
            sampleListId = studyId + "_cna";
        else if (!mutSelect && !cnaSelect && expSelect && !rppaSelect) {
            if (this.isProfileSelected(studyId + '_mrna_median_Zscores'))
                sampleListId = studyId + "_mrna";
            else if (this.isProfileSelected(studyId + '_rna_seq_mrna_median_Zscores'))
                sampleListId = studyId + "_rna_seq_mrna";
            else if (this.isProfileSelected(studyId + '_rna_seq_v2_mrna_median_Zscores'))
                sampleListId = studyId + "_rna_seq_v2_mrna";
        }
        else if ((mutSelect || cnaSelect) && expSelect && !rppaSelect)
            sampleListId = studyId + "_3way_complete";
        else if (!mutSelect && !cnaSelect && !expSelect && rppaSelect)
            sampleListId = studyId + "_rppa";

        // BEGIN HACK if not found
        if (!this.dict_sampleListId_sampleList[sampleListId]) {
            if (sampleListId === studyId + '_cnaseq')
                sampleListId = studyId + '_cna_seq';
            else if (sampleListId === studyId + "_3way_complete")
                sampleListId = studyId + "_complete";
        }
        // END HACK

        // if still not found
        if (!this.dict_sampleListId_sampleList[sampleListId])
            sampleListId = studyId + '_all';

        return sampleListId;
    }

    @computed get dict_sampleListId_sampleList(): _.Dictionary<SampleList | undefined> {
        return _.keyBy(this.sampleLists.result, sampleList => sampleList.sampleListId);
    }

    // GENES

    @computed get oql(): {
        query: SingleGeneQuery[],
        error?: { start: number, end: number, message: string }
    } {
        try {
            return {
                query: this.geneQuery ? parseOQLQuery(this.geneQuery.trim().toUpperCase()) : [],
                error: undefined
            };
        }
        catch (error) {
            if (error.name !== 'SyntaxError')
                return {
                    query: [],
                    error: {start: 0, end: 0, message: `Unexpected ${error}`}
                };

            let {location: {start: {offset}}} = error as SyntaxError;
            let near, start, end;
            if (offset === this.geneQuery.length)
                [near, start, end] = ['after', offset - 1, offset];
            else if (offset === 0)
                [near, start, end] = ['before', offset, offset + 1];
            else
                [near, start, end] = ['at', offset, offset + 1];
            let message = `OQL syntax error ${near} selected character; please fix and submit again.`;
            return {
                query: [],
                error: {start, end, message}
            };
        }
    }

    @computed get geneIds(): string[] {
        try {
            return this.oql.query.map(line => line.gene);
        }
        catch (e) {
            return [];
        }
    }

    // GENE SETS
    @computed get genesetIdsQuery(): { query: GenesetId[], error?: { start: number, end: number, message: string } } {
        try {
            const queriedGenesets: GenesetId[] = this.genesetQuery ? this.genesetQuery.split(/[ \n]+/) : [];
            return {
                query: queriedGenesets,
                error: undefined
            };
        }
        catch (error) {
            if (error.name !== 'SyntaxError')
                return {
                    query: [],
                    error: {start: 0, end: 0, message: `Unexpected ${error}`}
                };

            let {location: {start: {offset}}} = error as SyntaxError;
            let near, start, end;
            if (offset === this.geneQuery.length)
                [near, start, end] = ['after', offset - 1, offset];
            else if (offset === 0)
                [near, start, end] = ['before', offset, offset + 1];
            else
                [near, start, end] = ['at', offset, offset + 1];
            const message = `OQL syntax error ${near} selected character; please fix and submit again.`;
            return {
                query: [],
                error: {start, end, message}
            };
        }
    }

    @computed get genesetIds(): GenesetId[] {
        return this.genesetIdsQuery.query;
    }

    readonly hierarchyData = remoteData<any[]>({
        invoke: async () => {
            const hierarchyData = await getHierarchyData(
                this.getFilteredProfiles("GENESET_SCORE")[0].molecularProfileId,
                Number(this.volcanoPlotSelectedPercentile.value),
                0, 1, this.defaultSelectedSampleListId);
            return hierarchyData;
        }
    });


    readonly volcanoPlotTableData = remoteData<Geneset[]>({
        await: () => [this.hierarchyData],
        invoke: async () => {
            return getGenesetsFromHierarchy(this.hierarchyData.result!);
        }
    });

    @computed get minYVolcanoPlot(): number | undefined {
        if (this.volcanoPlotTableData.result) {
            return getVolcanoPlotMinYValue(this.volcanoPlotTableData.result);
        } else {
            return undefined;
        }
    }

    @observable map_genesets_selected_volcano = new ObservableMap<boolean>();

    @computed get volcanoPlotGraphData(): { x: number, y: number, fill: string }[] | undefined {
        if (this.volcanoPlotTableData.result) {
            return getVolcanoPlotData(this.volcanoPlotTableData.result, this.map_genesets_selected_volcano);
        } else {
            return undefined;
        }

    }

    // SUBMIT

    @computed get submitEnabled() {
        return (
            !this.submitError &&
            (this.genes.isComplete || this.genesets.isComplete) &&
            this.asyncUrlParams.isComplete
        ) || (!!this.oql.error || !!this.genesetIdsQuery.error); // to make "Please click 'Submit' to see location of error." possible
    }

    @computed get summaryEnabled() {
        return this.selectableSelectedStudyIds.length > 0;
    }

    @computed get hasSelectedStudies(){
        return this.selectableSelectedStudyIds.length > 0;
    }

    @computed get oqlMessages(): string[] {
        let unrecognizedMutations = _.flatten(this.oql.query.map(result => {
            return (result.alterations || []).filter(alt => (alt.alteration_type === 'mut' && (alt.info as any).unrecognized)) as MUTCommand<any>[];
        }));
        return unrecognizedMutations.map(mutCommand => {
            return `Unrecognized input "${(mutCommand as any).constr_val}" is interpreted as a mutation code.`;
        });
    }

    @computed get isQueryLimitReached(): boolean {
        return this.oql.query.length > AppConfig.serverConfig.query_gene_limit;
    }

    @computed get submitError() {
        let haveMutInQuery = false;
        let haveCnaInQuery = false;
        let haveExpInQuery = false;
        let haveProtInQuery = false;

        for (const queryLine of this.oql.query) {
            for (const alteration of (queryLine.alterations || [])) {
                haveMutInQuery = haveMutInQuery || (alteration.alteration_type === "mut");
                haveCnaInQuery = haveCnaInQuery || (alteration.alteration_type === "cna");
                haveExpInQuery = haveExpInQuery || (alteration.alteration_type === "exp");
                haveProtInQuery = haveProtInQuery || (alteration.alteration_type === "prot");
            }
        }

        if (!this.selectableSelectedStudyIds.length)
            return "Please select one or more cancer studies.";

        if (this.isSingleNonVirtualStudySelected) {
            if (!this.selectedProfileIds.length)
                return "Please select one or more molecular profiles.";

            let mutProfileSelected = this.getSelectedProfileIdFromMolecularAlterationType(AlterationTypeConstants.MUTATION_EXTENDED as any);
            let cnaProfileSelected = this.getSelectedProfileIdFromMolecularAlterationType(AlterationTypeConstants.COPY_NUMBER_ALTERATION as any);
            let expProfileSelected = this.getSelectedProfileIdFromMolecularAlterationType(AlterationTypeConstants.MRNA_EXPRESSION as any);
            let protProfileSelected = this.getSelectedProfileIdFromMolecularAlterationType(AlterationTypeConstants.PROTEIN_LEVEL as any);
            if (haveMutInQuery && !mutProfileSelected)
                return "Mutation data query specified in OQL, but no mutation profile selected in `Select Genomic Profiles`";
            if (haveCnaInQuery && !cnaProfileSelected)
                return "CNA data query specified in OQL, but not CNA profile selected in `Select Genomic Profiles`";
            if (haveExpInQuery && !expProfileSelected)
                return "mRNA expression data query specified in OQL, but no mRNA profile selected in `Select Genomic Profiles`";
            if (haveProtInQuery && !protProfileSelected)
                return "Protein level data query specified in OQL, but no protein level profile selected in `Select Genomic Profiles`";


        } else if (!(this.dataTypePriority.mutation || this.dataTypePriority.cna)) {
            return "Please select one or more molecular profiles.";
        }
        if (this.selectableSelectedStudyIds.length && this.selectedSampleListId === CUSTOM_CASE_LIST_ID) {
            if (this.asyncCustomCaseSet.isComplete && !this.asyncCustomCaseSet.result.length)
                return "Please enter at least one ID in your custom case set.";
            if (this.asyncCustomCaseSet.error)
                return "Error in custom case set.";
        }
        else if (haveExpInQuery && this.selectableSelectedStudyIds.length > 1) {
            return "Expression filtering in the gene list (the EXP command) is not supported when doing cross cancer queries.";
        }
        else if (haveProtInQuery && this.selectableSelectedStudyIds.length > 1) {
            return "Protein level filtering in the gene list (the PROT command) is not supported when doing cross cancer queries.";
        }

        if (this.selectedProfileIds.length !== 0) {
            if (this.selectedProfileIds.length === 1) {
                if (this.isGenesetProfileSelected) { //Only geneset profile selected
                    if (!this.genesetQuery.length && !this.oql.query.length) {
                        return "Please enter one or more gene symbols and gene sets.";
                    }
                    else if (!this.genesetQuery.length) {
                        return "Please enter one or more gene sets or deselect gene set profiles.";
                    }
                    else if (!this.oql.query.length) {
                        return "Please enter one or more gene symbols.";
                    }
                }
                else {
                    if (!this.oql.query.length) {
                        return "Please enter one or more gene symbols.";
                    }
                }
            }
            else {
                //Geneset and other genetic profiles selected
                if (this.isGenesetProfileSelected) {
                    if (!this.genesetQuery.length && !this.oql.query.length) {
                        return "Please enter one or more gene symbols and gene sets.";
                    }
                    else if (!this.oql.query.length) {
                        return "Please enter one or more gene symbols.";
                    }
                }
                else if (!this.oql.query.length) {
                    return "Please enter one or more gene symbols.";
                }
            }
        } else {
            if (!this.oql.query.length) {
                return "Please enter one or more gene symbols.";
            }
        }

        if (this.isQueryLimitReached) {
            return "Please limit your queries to 100 genes or fewer.";
        }

        if (this.genes.result.suggestions.length)
            return "Please edit the gene symbols.";
    }

    private readonly dict_molecularAlterationType_filenameSuffix: {[K in MolecularProfile['molecularAlterationType']]?: string} = {
        "MUTATION_EXTENDED": 'mutations',
        "COPY_NUMBER_ALTERATION": 'cna',
        "MRNA_EXPRESSION": 'mrna',
        "METHYLATION": 'methylation',
        "METHYLATION_BINARY": 'methylation',
        "PROTEIN_LEVEL": 'rppa',
    };

    @computed get downloadDataFilename() {
        let study = (this.selectableSelectedStudyIds.length === 1 && this.treeData.map_studyId_cancerStudy.get(this.selectableSelectedStudyIds[0]));
        let profile = this.dict_molecularProfileId_molecularProfile[this.selectedProfileIds[0] as string];

        if (!this.forDownloadTab || !study || !profile)
            return 'cbioportal-data.txt';

        let suffix = this.dict_molecularAlterationType_filenameSuffix[profile.molecularAlterationType] || profile.molecularAlterationType.toLowerCase();
        return `cbioportal-${study.studyId}-${suffix}.txt`;
    }

    readonly asyncUrlParams = remoteData({
        await: () => [this.asyncCustomCaseSet],
        invoke: async () => currentQueryParams(this)
    });

    ////////////////////////////////////////////////////////////////////////////////
    // ACTIONS
    ////////////////////////////////////////////////////////////////////////////////

    /**
     * This is used to prevent selections from being cleared automatically when new data is downloaded.
     */
    public initiallySelected = {
        profileIds: false,
        sampleListId: false
    };


    sanitizeQueryParams(str?: string) {
        return str ? decodeURIComponent(str).replace(/\+/g, "\n") : "";
    }

    @action setParamsFromUrl(url: string | { [k: string]: Partial<CancerStudyQueryUrlParams> }) {
        let params: Partial<CancerStudyQueryUrlParams>;
        if (typeof url === 'string') {
            let urlParts = URL.parse(url, true);
            params = urlParts.query as Partial<CancerStudyQueryUrlParams>;
        } else {
            params = url; // already an object
        }

        let profileIds = [
            params.genetic_profile_ids_PROFILE_MUTATION_EXTENDED,
            params.genetic_profile_ids_PROFILE_COPY_NUMBER_ALTERATION,
            params.genetic_profile_ids_PROFILE_MRNA_EXPRESSION,
            params.genetic_profile_ids_PROFILE_METHYLATION,
            params.genetic_profile_ids_PROFILE_PROTEIN_EXPRESSION,
            params.genetic_profile_ids_PROFILE_GENESET_SCORE,
        ];

        let queriedStudies = params.cancer_study_list ? params.cancer_study_list.split(",") : (params.cancer_study_id ? [params.cancer_study_id] : []);
        this.selectableSelectedStudyIds = queriedStudies;
        this._defaultSelectedIds = observable.map(stringListToSet(queriedStudies));

        this._selectedProfileIds = profileIds.every(id => id === undefined) ? undefined : profileIds.filter(_.identity) as string[];
        this.zScoreThreshold = params.Z_SCORE_THRESHOLD || '2.0';
        this.rppaScoreThreshold = params.RPPA_SCORE_THRESHOLD || '2.0';
        this.dataTypePriorityCode = params.data_priority || '0';
        this.selectedSampleListId = params.case_set_id ? params.case_set_id.toString() : "";  // must be a string even though it's integer
        this.caseIds = this.sanitizeQueryParams(params.case_ids);
        this.caseIdsMode = 'sample'; // url always contains sample IDs
        this.geneQuery = normalizeQuery(decodeURIComponent(params.gene_list || ''));
        this.genesetQuery = normalizeQuery(decodeURIComponent(params[QueryParameter.GENESET_LIST] || ''));
        this.forDownloadTab = params.tab_index === 'tab_download';
        this.initiallySelected.profileIds = true;
        this.initiallySelected.sampleListId = true;
    }

    // TODO: we should be able to merge this with the above since it accepts same interface
    @action setParamsFromLocalStorage(legacySubmission: Partial<CancerStudyQueryUrlParams>) {

        const caseIds = legacySubmission.case_ids;
        if (caseIds) {
            if (legacySubmission.case_set_id == CUSTOM_CASE_LIST_ID) {
                this.selectedSampleListId = CUSTOM_CASE_LIST_ID;
                this.caseIdsMode = 'sample';
                this.caseIds = caseIds.replace(/\+/g, "\n");
                this.initiallySelected.sampleListId = true;
            }
        }

        if (legacySubmission.cancer_study_list) {
            for (const studyId of legacySubmission.cancer_study_list.split(",")) {
                if (studyId !== "null") {
                    this.setStudyIdSelected(studyId, true);
                    this._defaultSelectedIds.set(studyId, true);
                }
            }
        }

    }


    @action selectCancerType(cancerType: CancerType, multiSelect?: boolean) {
        let clickedCancerTypeId = cancerType.cancerTypeId;

        if (multiSelect) {
            if (_.includes(this.selectedCancerTypeIds, clickedCancerTypeId))
                this.selectedCancerTypeIds = _.difference(this.selectedCancerTypeIds, [clickedCancerTypeId]);
            else
                this.selectedCancerTypeIds = _.union(this.selectedCancerTypeIds, [clickedCancerTypeId]);
        }
        else if (this.clickAgainToDeselectSingle && _.isEqual(toJS(this.selectedCancerTypeIds), [clickedCancerTypeId])) {
            this.selectedCancerTypeIds = [];
        }
        else {
            this.selectedCancerTypeIds = [clickedCancerTypeId];
        }
    }

    @action setSearchText(searchText: string) {
        this.clearSelectedCancerType();
        this.searchText = searchText;
    }

    @action clearSelectedCancerType() {
        this.selectedCancerTypeIds = [];
    }

    @action selectMolecularProfile(profile: MolecularProfile, checked: boolean) {
        let groupProfiles = this.getFilteredProfiles(profile.molecularAlterationType);
        let groupProfileIds = groupProfiles.map(profile => profile.molecularProfileId);
        if (this.forDownloadTab) {
            // download tab only allows a single selection
            this._selectedProfileIds = [profile.molecularProfileId];
        }
        else {
            let difference = _.difference(this.selectedProfileIds, groupProfileIds);
            if (checked)
                this._selectedProfileIds = _.union(difference, [profile.molecularProfileId]);
            else
                this._selectedProfileIds = difference;
        }
    }

    @action replaceGene(oldSymbol: string, newSymbol: string) {
        this.geneQuery = normalizeQuery(this.geneQuery.toUpperCase().replace(new RegExp(`\\b${oldSymbol.toUpperCase()}\\b`, 'g'), () => newSymbol.toUpperCase()));
    }

    @action replaceGeneset(oldGeneset: string, newGeneset: string) {
        this.genesetQuery = normalizeQuery(this.genesetQuery.toUpperCase().replace(new RegExp(`\\b${oldGeneset.toUpperCase()}\\b`, 'g'), () => newGeneset.toUpperCase()));
    }

    @action applyGeneSelection(map_geneSymbol_selected: ObservableMap<boolean>) {
        let [toAppend, toRemove] = _.partition(map_geneSymbol_selected.keys(), geneSymbol => map_geneSymbol_selected.get(geneSymbol));
        toAppend = _.difference(toAppend, this.geneIds);
        toRemove = _.intersection(toRemove, this.geneIds);
        for (let geneSymbol of toRemove)
            this.replaceGene(geneSymbol, '');
        this.geneQuery = normalizeQuery([this.geneQuery, ...toAppend].join(' '));
    }

    @action addToGenesetSelection(map_geneset_selected: ObservableMap<boolean>) {
        let [toAppend, toRemove] = _.partition(map_geneset_selected.keys(), geneSet => map_geneset_selected.get(geneSet));
        const genesetQuery = _.union(toAppend, this.genesetIds).join(' ');
        this.genesetQuery = normalizeQuery(genesetQuery);
    }

    @action applyGenesetSelection(map_geneset_selected: ObservableMap<boolean>) {
        const [toAppend, toRemove] = _.partition(map_geneset_selected.keys(), geneSet => map_geneset_selected.get(geneSet));
        let genesetQuery = this.genesetQuery;
        if (toAppend.length > 0) {
            let genesetList: string[] = [];
            for (const geneset of toAppend) {
                genesetList.push(geneset);
            }
            genesetQuery = genesetList.join(" ");
        }
        if (toRemove.length > 0) {
            let genesetList = genesetQuery.split(" ");
            for (const removeGeneset of toRemove) {
                for (const geneset of genesetList) {
                    if (removeGeneset === geneset) {
                        const index = genesetList.indexOf(geneset);
                        if (index >= 0) {
                            genesetList.splice(index, 1);
                        }
                    }
                }
            }
            genesetQuery = genesetList.join(" ");
        }
        genesetQuery = normalizeQuery(genesetQuery);
        this.genesetQuery = genesetQuery;
    }


    @action submit() {
        if (this.oql.error) {
            this.geneQueryErrorDisplayStatus = 'shouldFocus';
            this.genesetQueryErrorDisplayStatus = 'shouldFocus';
            return false;
        }

        if (!this.submitEnabled || !this.asyncUrlParams.isComplete)
            return false;

        let urlParams = this.asyncUrlParams.result;

        if (this.forDownloadTab) {
            formSubmit(buildCBioPortalPageUrl("data_download"), urlParams.query, undefined, "smart");
        } else {
            this.singlePageAppSubmitRoutine(urlParams.query);
        }

        return true;

    }

    @action openSummary() {

        if (!this.summaryEnabled) {
            return;
        }

        redirectToStudyView(this.selectableSelectedStudyIds);
    }

    @cached get molecularProfilesInStudyCache() {
        return new MolecularProfilesInStudyCache();

    }

    @cached get sampleListsInStudyCache() {
        return new SampleListsInStudyCache();
    }
}

export const QueryStoreComponent = ComponentGetsStoreContext(QueryStore);

const selectedGeneSets = '';
export default selectedGeneSets;
