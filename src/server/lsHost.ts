/// <reference path="..\services\services.ts" />
/// <reference path="utilities.ts" />
/// <reference path="scriptInfo.ts" />

namespace ts.server {
    export class LSHost implements ts.LanguageServiceHost, ModuleResolutionHost, ServerLanguageServiceHost {
        private compilationSettings: ts.CompilerOptions;
        private readonly resolvedModuleNames: ts.FileMap<Map<ResolvedModuleWithFailedLookupLocations>>;
        private readonly resolvedTypeReferenceDirectives: ts.FileMap<Map<ResolvedTypeReferenceDirectiveWithFailedLookupLocations>>;
        private readonly getCanonicalFileName: (fileName: string) => string;

        private readonly resolveModuleName: typeof resolveModuleName;
        readonly trace: (s: string) => void;

        constructor(private readonly host: ServerHost, private readonly project: Project, private readonly cancellationToken: HostCancellationToken) {
            this.getCanonicalFileName = ts.createGetCanonicalFileName(this.host.useCaseSensitiveFileNames);
            this.resolvedModuleNames = createFileMap<Map<ResolvedModuleWithFailedLookupLocations>>();
            this.resolvedTypeReferenceDirectives = createFileMap<Map<ResolvedTypeReferenceDirectiveWithFailedLookupLocations>>();

            if (host.trace) {
                this.trace = s => host.trace(s);
            }

            this.resolveModuleName = (moduleName, containingFile, compilerOptions, host) => {
                const primaryResult = resolveModuleName(moduleName, containingFile, compilerOptions, host);
                if (primaryResult.resolvedModule) {
                    return primaryResult;
                }
                const globalCache = this.project.projectService.typingsInstaller.globalTypingsCacheLocation;
                if (this.project.getTypingOptions().enableAutoDiscovery && globalCache) {
                    const traceEnabled = isTraceEnabled(compilerOptions, host);
                    if (traceEnabled) {
                        trace(host, Diagnostics.Auto_discovery_for_typings_is_enabled_in_project_0_Running_extra_resolution_pass_for_module_1_using_cache_location_2, this.project.getProjectName(), moduleName, globalCache);
                    }
                    const state: ModuleResolutionState = { compilerOptions, host, skipTsx: false, traceEnabled };
                    const resolvedName = loadModuleFromNodeModules(moduleName, globalCache, primaryResult.failedLookupLocations, state, /*checkOneLevel*/ true);
                    if (resolvedName) {
                        return createResolvedModule(resolvedName, /*isExternalLibraryImport*/ true, primaryResult.failedLookupLocations);
                    }
                }
                return primaryResult;
            };
        }

        private resolveNamesWithLocalCache<T extends { failedLookupLocations: string[] }, R>(
            names: string[],
            containingFile: string,
            cache: ts.FileMap<Map<T>>,
            loader: (name: string, containingFile: string, options: CompilerOptions, host: ModuleResolutionHost) => T,
            getResult: (s: T) => R): R[] {

            const path = toPath(containingFile, this.host.getCurrentDirectory(), this.getCanonicalFileName);
            const currentResolutionsInFile = cache.get(path);

            const newResolutions: Map<T> = createMap<T>();
            const resolvedModules: R[] = [];
            const compilerOptions = this.getCompilationSettings();

            for (const name of names) {
                // check if this is a duplicate entry in the list
                let resolution = newResolutions[name];
                if (!resolution) {
                    const existingResolution = currentResolutionsInFile && currentResolutionsInFile[name];
                    if (moduleResolutionIsValid(existingResolution)) {
                        // ok, it is safe to use existing name resolution results
                        resolution = existingResolution;
                    }
                    else {
                        newResolutions[name] = resolution = loader(name, containingFile, compilerOptions, this);
                    }
                }

                ts.Debug.assert(resolution !== undefined);

                resolvedModules.push(getResult(resolution));
            }

            // replace old results with a new one
            cache.set(path, newResolutions);
            return resolvedModules;

            function moduleResolutionIsValid(resolution: T): boolean {
                if (!resolution) {
                    return false;
                }

                if (getResult(resolution)) {
                    // TODO: consider checking failedLookupLocations
                    return true;
                }

                // consider situation if we have no candidate locations as valid resolution.
                // after all there is no point to invalidate it if we have no idea where to look for the module.
                return resolution.failedLookupLocations.length === 0;
            }
        }

        getProjectVersion() {
            return this.project.getProjectVersion();
        }

        getCompilationSettings() {
            return this.compilationSettings;
        }

        useCaseSensitiveFileNames() {
            return this.host.useCaseSensitiveFileNames;
        }

        getCancellationToken() {
            return this.cancellationToken;
        }

        resolveTypeReferenceDirectives(typeDirectiveNames: string[], containingFile: string): ResolvedTypeReferenceDirective[] {
            return this.resolveNamesWithLocalCache(typeDirectiveNames, containingFile, this.resolvedTypeReferenceDirectives, resolveTypeReferenceDirective, m => m.resolvedTypeReferenceDirective);
        }

        resolveModuleNames(moduleNames: string[], containingFile: string): ResolvedModule[] {
            return this.resolveNamesWithLocalCache(moduleNames, containingFile, this.resolvedModuleNames, this.resolveModuleName, m => m.resolvedModule);
        }

        getDefaultLibFileName() {
            const nodeModuleBinDir = getDirectoryPath(normalizePath(this.host.getExecutingFilePath()));
            return combinePaths(nodeModuleBinDir, getDefaultLibFileName(this.compilationSettings));
        }

        getScriptSnapshot(filename: string): ts.IScriptSnapshot {
            const scriptInfo = this.project.getScriptInfoLSHost(filename);
            if (scriptInfo) {
                return scriptInfo.snap();
            }
        }

        getScriptFileNames() {
            return this.project.getRootFilesLSHost();
        }

        getScriptKind(fileName: string) {
            const info = this.project.getScriptInfoLSHost(fileName);
            return info && info.scriptKind;
        }

        getScriptVersion(filename: string) {
            const info = this.project.getScriptInfoLSHost(filename);
            return info && info.getLatestVersion();
        }

        getCurrentDirectory(): string {
            return "";
        }

        resolvePath(path: string): string {
            return this.host.resolvePath(path);
        }

        fileExists(path: string): boolean {
            return this.host.fileExists(path);
        }

        directoryExists(path: string): boolean {
            return this.host.directoryExists(path);
        }

        readFile(fileName: string): string {
            return this.host.readFile(fileName);
        }

        getDirectories(path: string): string[] {
            return this.host.getDirectories(path);
        }

        notifyFileRemoved(info: ScriptInfo) {
            this.resolvedModuleNames.remove(info.path);
            this.resolvedTypeReferenceDirectives.remove(info.path);
        }

        setCompilationSettings(opt: ts.CompilerOptions) {
            this.compilationSettings = opt;
            // conservatively assume that changing compiler options might affect module resolution strategy
            this.resolvedModuleNames.clear();
            this.resolvedTypeReferenceDirectives.clear();
        }
    }
}