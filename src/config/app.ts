import fs, {PathLike} from 'fs';
import semver from 'semver';
import parseJsonFile from '../json';
import {Tool, ToolExecutionType} from '../tools';
import {CURRENT_STABLE, INSTALLABLE_VERSIONS, InstallablePhpVersionType, isInstallableVersion} from './php';
import {ComposerJson} from './composer';
import {ConfigurationFromFile, isAdditionalChecksConfiguration, isAnyComposerDependencySet, isAnyPhpVersionType, isConfigurationContainingJobExclusions, isExplicitChecksConfiguration, isLatestPhpVersionType, isLowestPhpVersionType, JobDefinitionFromFile, JobFromFile, JobToExcludeFromFile, WILDCARD_ALIAS} from './input';

export const OPERATING_SYSTEM = 'ubuntu-latest';
export const ACTION = 'laminas/laminas-continuous-integration-action@v1';

export enum ComposerDependencySet {
    LOWEST = 'lowest',
    LOCKED = 'locked',
    LATEST = 'latest',
}

function gatherVersions(composerJson: ComposerJson): InstallablePhpVersionType[] {
    if (JSON.stringify(composerJson) === '{}') {
        return [];
    }

    const composerPhpVersion: string = (composerJson.require?.php ?? '').replace(/,\s/, ' ');

    if (composerPhpVersion === '') {
        return [];
    }

    return INSTALLABLE_VERSIONS
        .filter((version) => semver.satisfies(`${version}.0`, composerPhpVersion));
}

function gatherExtensions(composerJson: ComposerJson): Set<string> {
    let extensions: Set<string> = new Set();
    const EXTENSION_EXPRESSION = new RegExp(/^ext-/);

    Object.keys(composerJson.require ?? {})
        .filter((requirement) => EXTENSION_EXPRESSION.test(requirement))
        .forEach((requirement) => extensions = extensions.add(requirement.replace(EXTENSION_EXPRESSION, '')));

    Object.keys(composerJson['require-dev'] ?? {})
        .filter((requirement) => EXTENSION_EXPRESSION.test(requirement))
        .forEach((requirement) => extensions = extensions.add(requirement.replace(EXTENSION_EXPRESSION, '')));

    return extensions;
}

export interface JobDefinition {
    command: string;
    php: InstallablePhpVersionType;
    phpExtensions: string[];
    phpIni: string[];
    composerDependencySet: ComposerDependencySet;
    ignorePhpPlatformRequirement: boolean;
    additionalComposerArguments: string[];
}

export interface Job {
    name: string;
    job: JobDefinition;
    operatingSystem: string;
    action: string;
}

export interface JobToExclude {
    name: string;
}

export interface Config {
    readonly codeChecks: boolean;
    readonly docLinting: boolean;
    readonly versions: InstallablePhpVersionType[];
    readonly stablePhpVersion: InstallablePhpVersionType;
    readonly minimumPhpVersion: InstallablePhpVersionType;
    readonly latestPhpVersion: InstallablePhpVersionType;
    readonly lockedDependenciesExists: boolean;
    readonly phpExtensions: string[];
    readonly phpIni: string[];
    readonly exclude: JobToExclude[];
    readonly ignorePhpPlatformRequirements: IgnorePhpPlatformRequirements;
    readonly additionalComposerArguments: string[];
}
export interface Requirements {
    readonly codeChecks: boolean;
    readonly docLinting: boolean;
}

function gatherJobExclusions(config: ConfigurationFromFile): JobToExclude[] {
    if (isExplicitChecksConfiguration(config)) {
        return [];
    }

    if (isConfigurationContainingJobExclusions(config)) {
        return config.exclude ?? [];
    }

    return [];
}

function discoverPhpVersionsForJob(job: JobDefinitionFromFile, appConfig: Config): InstallablePhpVersionType[] {
    if (!isInstallableVersion(job.php ?? '')) {
        return [ appConfig.stablePhpVersion ];
    }

    const phpFromJob = job.php as InstallablePhpVersionType;

    if (isAnyPhpVersionType(phpFromJob)) {
        return appConfig.versions;
    }

    if (isLowestPhpVersionType(phpFromJob)) {
        return [ appConfig.minimumPhpVersion ];
    }

    if (isLatestPhpVersionType(phpFromJob)) {
        return [ appConfig.latestPhpVersion ];
    }

    return [ phpFromJob ];
}

function discoverComposerDependencySetsForJob(job: JobDefinitionFromFile): ComposerDependencySet[] {
    const dependencySetFromConfig = job.dependencies ?? WILDCARD_ALIAS;

    if (isAnyComposerDependencySet(dependencySetFromConfig)) {
        return [ ComposerDependencySet.LOWEST, ComposerDependencySet.LATEST ];
    }

    return [ dependencySetFromConfig ];
}

function discoverIgnorePhpPlatformRequirementForJobByVersion(
    job: JobDefinitionFromFile,
    phpVersion: InstallablePhpVersionType,
    appConfig: Config
): boolean {
    if (job.ignore_php_platform_requirement ?? false) {
        return true;
    }

    return appConfig.ignorePhpPlatformRequirements[phpVersion] ?? false;
}

function discoverAdditionalComposerArgumentsForCheck(job: JobDefinitionFromFile, appConfig: Config): string[] {
    return [ ... new Set([
        ... appConfig.additionalComposerArguments ?? [],
        ... job.additional_composer_arguments ?? []
    ]) ];
}

function convertJobDefinitionFromFileToJobDefinition(
    phpVersion: InstallablePhpVersionType,
    composerDependencySet: ComposerDependencySet,
    job: JobDefinitionFromFile,
    appConfig: Config
): JobDefinition {
    return {
        php                          : phpVersion,
        phpExtensions                : job.extensions ?? appConfig.phpExtensions,
        command                      : job.command,
        phpIni                       : job.ini ?? appConfig.phpIni,
        composerDependencySet        : composerDependencySet,
        ignorePhpPlatformRequirement : discoverIgnorePhpPlatformRequirementForJobByVersion(job, phpVersion, appConfig),
        additionalComposerArguments  : discoverAdditionalComposerArgumentsForCheck(job, appConfig)
    };
}

function convertJobFromFileToJobs(job: JobFromFile, appConfig: Config): Job[] {
    const jobDefinition: JobDefinitionFromFile = job.job;
    const composerDependencySets = discoverComposerDependencySetsForJob(jobDefinition);
    const phpVersionsToRunTheChecksWith = discoverPhpVersionsForJob(jobDefinition, appConfig);
    const jobs: Job[] = [];

    phpVersionsToRunTheChecksWith.forEach(
        (version) => composerDependencySets.forEach(
            (dependencySet) => jobs.push({
                operatingSystem : OPERATING_SYSTEM,
                action          : ACTION,
                job             : convertJobDefinitionFromFileToJobDefinition(
                    version,
                    dependencySet,
                    jobDefinition,
                    appConfig
                ),
                name : job.name
            })
        )
    );

    return jobs;
}

function isJobExcluded(job: Job, exclusions: JobToExcludeFromFile[]) {
    if (exclusions.length === 0) {
        return false;
    }

    return exclusions
        .some((exclude) => job.name === exclude.name);
}

function createJob(
    name: string,
    command: string,
    phpVersion: InstallablePhpVersionType,
    composerDependencySet: ComposerDependencySet,
    config: Config
): Job {
    return {
        name            : `${ name } [${ phpVersion }, ${ composerDependencySet }]`,
        action          : ACTION,
        operatingSystem : OPERATING_SYSTEM,
        job             : {
            command,
            php                          : phpVersion,
            phpExtensions                : config.phpExtensions,
            phpIni                       : config.phpIni,
            composerDependencySet        : composerDependencySet,
            ignorePhpPlatformRequirement : config.ignorePhpPlatformRequirements[phpVersion] ?? false,
            additionalComposerArguments  : config.additionalComposerArguments
        }
    };
}

function createJobs(
    config: Config,
    tool: Tool
): Job[] {
    const jobs: Job[] = [];

    if (tool.executionType === ToolExecutionType.STATIC) {
        const lockedOrLatestDependencySet: ComposerDependencySet = config.lockedDependenciesExists
            ? ComposerDependencySet.LOCKED
            : ComposerDependencySet.LATEST;


        return [ createJob(tool.name, tool.command, config.minimumPhpVersion, lockedOrLatestDependencySet, config) ];
    }

    if (tool.executionType === ToolExecutionType.MATRIX) {
        if (config.lockedDependenciesExists) {
            jobs.push(createJob(
                tool.name,
                tool.command,
                config.minimumPhpVersion,
                ComposerDependencySet.LOCKED,
                config
            ));
        }

        config.versions.forEach((version) => jobs.push(
            createJob(tool.name, tool.command, version, ComposerDependencySet.LOWEST, config),
            createJob(tool.name, tool.command, version, ComposerDependencySet.LATEST, config),
        ));
    }

    return jobs;
}

export function createChecksForKnownTools(config: Config, tools: Tool[]): Job[] {
    return tools
        .flatMap((tool) => createJobs(config, tool));
}

function createNoOpCheck(appConfig: Config): Job {
    return {
        name            : 'No checks',
        operatingSystem : OPERATING_SYSTEM,
        action          : ACTION,
        job             : {
            php                          : appConfig.stablePhpVersion,
            phpExtensions                : [],
            command                      : '',
            composerDependencySet        : ComposerDependencySet.LOCKED,
            phpIni                       : [],
            ignorePhpPlatformRequirement : appConfig.ignorePhpPlatformRequirements[appConfig.stablePhpVersion] ?? false,
            additionalComposerArguments  : appConfig.additionalComposerArguments,
        }
    };
}

export function gatherChecks(config: ConfigurationFromFile, appConfig: Config, tools: Tool[]): [Job, ...Job[]] {
    if (isExplicitChecksConfiguration(config)) {
        const checks = (config.checks?.map((job) => convertJobFromFileToJobs(job, appConfig)) ?? []).flat(1);

        if (checks.length === 0) {
            return [ createNoOpCheck(appConfig) ];
        }

        return checks as [Job, ...Job[]];
    }

    let checks = createChecksForKnownTools(appConfig, tools);

    if (isAdditionalChecksConfiguration(config)) {
        const generatedChecksFromAdditionalChecksConfiguration = (
            config.additional_checks?.map((job) => convertJobFromFileToJobs(job, appConfig)) ?? []
        ).flat(1).filter((check, index, carry) => carry.indexOf(check) === index);

        checks = [ ...checks, ...generatedChecksFromAdditionalChecksConfiguration ];
    }

    const exclusions = isConfigurationContainingJobExclusions(config) ? config.exclude ?? [] : [];

    checks = checks.filter((job) => !isJobExcluded(job, exclusions));
    if (checks.length === 0) {
        return [
            createNoOpCheck(appConfig)
        ];
    }

    return checks as [Job, ...Job[]];
}

export default function createConfig(
    requirements: Requirements,
    composerJsonFileName: PathLike,
    composerLockJsonFileName: PathLike,
    continousIntegrationConfigurationJsonFileName: PathLike
): Config {
    const composerJson: ComposerJson = parseJsonFile(composerJsonFileName) as ComposerJson;
    const configurationFromFile: ConfigurationFromFile =
        parseJsonFile(continousIntegrationConfigurationJsonFileName) as ConfigurationFromFile;
    const phpVersionsSupportedByProject: InstallablePhpVersionType[] = gatherVersions(composerJson);
    let phpExtensions: Set<string> = gatherExtensions(composerJson);
    let stablePHPVersion: InstallablePhpVersionType = CURRENT_STABLE;

    if (isInstallableVersion(configurationFromFile.stablePHP ?? '')) {
        stablePHPVersion = configurationFromFile.stablePHP as InstallablePhpVersionType;
    }

    let minimumPHPVersion: InstallablePhpVersionType = stablePHPVersion;
    let maximumPHPVersion: InstallablePhpVersionType = stablePHPVersion;

    if (phpVersionsSupportedByProject.length > 0) {
        minimumPHPVersion = phpVersionsSupportedByProject[0] as InstallablePhpVersionType;
        maximumPHPVersion =
            phpVersionsSupportedByProject[phpVersionsSupportedByProject.length - 1] as InstallablePhpVersionType;
    }

    configurationFromFile.extensions?.forEach((extension) => phpExtensions = phpExtensions.add(extension));

    return {
        codeChecks                    : requirements.codeChecks,
        docLinting                    : requirements.docLinting,
        versions                      : phpVersionsSupportedByProject,
        phpExtensions                 : [ ...phpExtensions ],
        stablePhpVersion              : stablePHPVersion,
        minimumPhpVersion             : minimumPHPVersion,
        latestPhpVersion              : maximumPHPVersion,
        phpIni                        : configurationFromFile.ini ?? [],
        lockedDependenciesExists      : fs.existsSync(composerLockJsonFileName),
        exclude                       : gatherJobExclusions(configurationFromFile),
        ignorePhpPlatformRequirements : configurationFromFile.ignore_php_platform_requirements ?? {},
        additionalComposerArguments   : [ ... new Set(configurationFromFile.additional_composer_arguments ?? []) ],
    };
}

export type IgnorePhpPlatformRequirements = Partial<Record<typeof INSTALLABLE_VERSIONS[number], boolean>>
