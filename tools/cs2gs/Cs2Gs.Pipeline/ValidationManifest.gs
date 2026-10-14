// <copyright file="ValidationManifest.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Security.Cryptography
import System.Text
import System.Text.Json
import System.Text.Json.Serialization

/// The per-app hand-off between a translate-only `migrate` run and a later
/// `validate` run over the same migrated tree (issue #3668).
///
/// Sharding the self-migration gate splits it into ONE whole-repository
/// translate pass and N independent per-app validation shards. Translation must
/// stay whole-repository — linked sources (e.g. `test/Shared/*.cs`) are
/// compiled into several projects and (cref:PipelineOptions.RepositoryTranslations)
/// cross-checks that they translate identically everywhere; splitting the
/// translate pass would silently disable that guard. Stages 2–4 (compile,
/// ilverify, test-parity), by contrast, only read the migrated tree, so they
/// shard cleanly.
///
/// The only translate-derived state stages 2–4 consume in repository layout is
/// captured here: the emitted `.gs` file set (compile-error attribution and
/// the `!!` polish pass), the external reference paths (ilverify's
/// `-r` set), and the project classification flags. The G# source text
/// itself is NOT stored — it is read back from the migrated tree, which is
/// exactly what a whole run would have on disk at that point.
class ValidationManifest {
    /// Gets or sets the corpus app id.
    @JsonPropertyName("appId")
    @JsonPropertyOrder(int32(0))
    prop AppId string

    /// Gets or sets a value indicating whether the translate stage passed for this app.
    @JsonPropertyName("translated")
    @JsonPropertyOrder(int32(1))
    prop Translated bool

    /// Gets or sets a value indicating whether the source project is a test project.
    @JsonPropertyName("isTestProject")
    @JsonPropertyOrder(int32(2))
    prop IsTestProject bool

    /// Gets or sets a value indicating whether the app targets the G# analyzer API.
    @JsonPropertyName("isAnalyzerProject")
    @JsonPropertyOrder(int32(3))
    prop IsAnalyzerProject bool

    /// Gets or sets a value indicating whether the analyzer detector classified the app as a test project.
    @JsonPropertyName("isAnalyzerTestProject")
    @JsonPropertyOrder(int32(4))
    prop IsAnalyzerTestProject bool

    /// Gets or sets the source project's root namespace.
    @JsonPropertyName("rootNamespace")
    @JsonPropertyOrder(int32(5))
    prop RootNamespace string

    /// Gets or sets the source project's assembly name.
    @JsonPropertyName("assemblyName")
    @JsonPropertyOrder(int32(6))
    prop AssemblyName string?

    /// Gets or sets the friend assemblies contributed by generated sources.
    private var _generatedFriendAssemblies List[string] = List[string]()

    @JsonPropertyName("generatedFriendAssemblies")
    @JsonPropertyOrder(int32(7))
    prop GeneratedFriendAssemblies List[string] {
        get {
            return _generatedFriendAssemblies
        }
        set {
            _generatedFriendAssemblies = value
        }
    }

    /// Gets or sets the absolute external (NuGet package) assembly paths the C#
    /// compilation resolved against. Consumed by the IL-verify stage. A shard
    /// filters out any path that does not exist on its own runner; ilverify
    /// already scans the emitted assembly's output directory, so a package copy
    /// that a shard cannot see is additive, never load-bearing.
    private var _externalReferences List[string] = List[string]()

    @JsonPropertyName("externalReferences")
    @JsonPropertyOrder(int32(8))
    prop ExternalReferences List[string] {
        get {
            return _externalReferences
        }
        set {
            _externalReferences = value
        }
    }

    /// Gets or sets the emitted G# files, relative to the migrated tree root.
    private var _emittedFiles List[ValidationManifestFile] = List[ValidationManifestFile]()

    @JsonPropertyName("emittedFiles")
    @JsonPropertyOrder(int32(9))
    prop EmittedFiles List[ValidationManifestFile] {
        get {
            return _emittedFiles
        }
        set {
            _emittedFiles = value
        }
    }

    /// Gets or sets the producing corpus root, retained as source-path provenance.
    @JsonPropertyName("sourceRoot")
    @JsonPropertyOrder(int32(10))
    prop SourceRoot string?

    /// Gets or sets the corpus-relative source project owning this manifest.
    @JsonPropertyName("sourceProjectPath")
    @JsonPropertyOrder(int32(11))
    prop SourceProjectPath string?

    /// Rehydrates the translate-derived state of this manifest onto a stage
    /// execution context, reading each emitted file's current text from the
    /// migrated tree. Files that no longer exist are dropped: a whole run would
    /// equally have nothing to attribute a diagnostic to.
    /// @param context The context to populate.
    /// @param migratedRoot The migrated tree root.
    func Hydrate(context StageExecutionContext?, migratedRoot string) {
        if context == nil {
            throw ArgumentNullException("context")
        }
        let root = Path.GetFullPath(migratedRoot ?? throw ArgumentNullException("migratedRoot"))
        if !string.Equals(this.AppId, context.App.Id, StringComparison.Ordinal) {
            throw InvalidOperationException(
                "Validation manifest for '${this.AppId}' cannot hydrate app '${context.App.Id}'."
            )
        }
        let sourceRoot string? = CanonicalRootPath.Resolve(context.Options.SourceRoot)
        if string.IsNullOrEmpty(sourceRoot) {
            throw InvalidOperationException("Validation requires the authoritative --corpus source root.")
        }
        var producingRoot string? = this.SourceRoot
        if producingRoot != nil {
            if string.IsNullOrWhiteSpace(producingRoot) {
                throw InvalidOperationException(
                    "Validation manifest requires a non-empty producing corpus source root."
                )
            }
            let projectPath string? = ResolveWithinRoot(sourceRoot, this.SourceProjectPath)
            if !string.Equals(
                projectPath,
                CanonicalRootPath.Resolve(context.App.ProjectPath),
                if OperatingSystem.IsWindows() {
                    StringComparison.OrdinalIgnoreCase
                } else {
                    StringComparison.Ordinal
                }
            ) {
                throw InvalidOperationException(
                    "Validation manifest source project '${this.SourceProjectPath}' does not own app '${context.App.Id}'."
                )
            }
        } else {
            if this.SourceProjectPath != nil || this.EmittedFiles.Any(
                (file ValidationManifestFile) -> file.RelativeCsPath != nil
            ) {
                throw InvalidOperationException("Validation manifest has incomplete portable source metadata.")
            }
            producingRoot = this.LegacySourceRoot(context, sourceRoot)
        }
        context.IsTestProject = this.IsTestProject
        context.IsAnalyzerProject = this.IsAnalyzerProject
        context.IsAnalyzerTestProject = this.IsAnalyzerTestProject
        context.RootNamespace = this.RootNamespace
        context.AssemblyName = this.AssemblyName
        for friend in this.GeneratedFriendAssemblies {
            context.GeneratedFriendAssemblies.Add(friend)
        }
        for reference in this.ExternalReferences {
            // A shard runs on a different machine than the translate pass: a
            // package path that is not present here is dropped rather than
            // handed to ilverify as a dangling -r (which it reports as a load
            // error). The emitted assembly's own output directory is scanned
            // by IlVerifyRunner regardless, so real dependencies still resolve.
            if File.Exists(reference) {
                context.ExternalReferencePaths.Add(reference)
            }
        }
        for file in this.EmittedFiles {
            let gsPath string? = ResolveWithinRoot(root, file.Path)
            var csPath string? = file.CsFilePath
            if string.IsNullOrEmpty(csPath) {
                throw InvalidOperationException("Validation file '${file.Path}' has no original source identity.")
            }
            let relativeCsPath = SourceRelativePath(producingRoot, csPath)
            if this.SourceRoot != nil && !string.Equals(
                relativeCsPath,
                Normalize(file.RelativeCsPath),
                StringComparison.Ordinal
            ) {
                throw InvalidOperationException("Validation manifest source identity disagrees for '$csPath'.")
            }
            csPath = ResolveWithinRoot(sourceRoot, relativeCsPath)
            if file.GeneratedSource != nil {
                if this.SourceRoot == nil || !RepositoryFileInventory.IsBuildOutputPath(relativeCsPath) {
                    throw InvalidOperationException(
                        "Validation source '$relativeCsPath' is not a portable build-generated input."
                    )
                }
                let owner string? = ResolveWithinRoot(sourceRoot, file.GeneratedSource!!.SourceProjectPath)
                let ownsApp = string.Equals(
                    owner,
                    CanonicalRootPath.Resolve(context.App.ProjectPath),
                    if OperatingSystem.IsWindows() {
                        StringComparison.OrdinalIgnoreCase
                    } else {
                        StringComparison.Ordinal
                    }
                )
                if !File.Exists(owner) || ownsApp == file.FromReferencedProject {
                    throw InvalidOperationException(
                        "Generated validation source '$relativeCsPath' has inconsistent project ownership."
                    )
                }
                file.GeneratedSource!!.Validate()
            } else if !File.Exists(csPath) {
                throw InvalidOperationException(
                    "Validation source '$relativeCsPath' is missing from authoritative corpus '$sourceRoot'."
                )
            } else {
                // Unlike the best-effort Fact reader, replay must not silently
                // lose authoritative source evidence to a stale/unreadable path.
                using let source = File.OpenRead(csPath)
            }
            if !File.Exists(gsPath) {
                continue
            }
            context.EmittedFiles.Add(
                EmittedGsFile(gsPath, file.RelativeGsPath, csPath, File.ReadAllText(gsPath)){
                    IsFromReferencedProject = file.FromReferencedProject,
                    GeneratedSource = file.GeneratedSource
                }
            )
        }
    }

    private func LegacySourceRoot(context StageExecutionContext, sourceRoot string?) string {
        // Repository translation preserves the FULL corpus-relative path of
        // every primary C# unit. Namespace splits/resx output are not anchors.
        // Never search by basename or choose a root because a file exists there.
        let roots = HashSet[string](StringComparer.Ordinal)
        let projectPath string? = CanonicalRootPath.Resolve(context.App.ProjectPath)
        let owners = RepositoryExcludedScope.Compute(sourceRoot, []string{projectPath!!})
        let ownsCorpusRoot = string.Equals(
            Path.GetDirectoryName(projectPath),
            sourceRoot,
            if OperatingSystem.IsWindows() {
                StringComparison.OrdinalIgnoreCase
            } else {
                StringComparison.Ordinal
            }
        )
        var hasOwnedAnchor = false
        for file in this.EmittedFiles {
            if string.IsNullOrEmpty(file.CsFilePath) || !file.CsFilePath!!.EndsWith(
                ".cs",
                StringComparison.OrdinalIgnoreCase
            ) {
                continue
            }
            let relative string? = Normalize(
                Path.ChangeExtension(Normalize(file.Path), Path.GetExtension(Normalize(file.CsFilePath)))
            )
            ValidateRelativePath(relative)
            let original string? = Normalize(file.CsFilePath)
            let suffix = "/" + relative
            if !original!!.EndsWith(suffix, ProducingPathComparison(original)) {
                continue
            }
            let producingRoot = original!![.. ^relative!!.Length]
            roots.Add(
                if ProducingPathComparison(producingRoot) == StringComparison.OrdinalIgnoreCase {
                    producingRoot.ToUpperInvariant()
                } else {
                    producingRoot
                }
            )
            hasOwnedAnchor |= !file.FromReferencedProject && (ownsCorpusRoot || owners.IsExcluded(relative))
        }
        if roots.Count != 1 || !hasOwnedAnchor {
            throw InvalidOperationException(
                "Legacy validation manifest for '${this.AppId}' has no unambiguous owning corpus source root."
            )
        }
        return roots.Single()
    }

    shared {
        /// The manifest file name written into each app's artifact directory.
        const FileName string = "validation-context.json"

        /// Captures the translate-derived state of one app into a manifest.
        /// @param context The app's stage execution context after translate.
        /// @param translated Whether the translate stage passed.
        /// @param migratedRoot The migrated tree root, used to relativize emitted paths.
        /// @returns The populated manifest.
        func Capture(context StageExecutionContext?, translated bool, migratedRoot string?) ValidationManifest {
            if context == nil {
                throw ArgumentNullException("context")
            }
            let root = Path.GetFullPath(migratedRoot ?? throw ArgumentNullException("migratedRoot"))
            let sourceRoot string? = CanonicalRootPath.Resolve(context.Options.SourceRoot)
            if string.IsNullOrEmpty(sourceRoot) {
                throw InvalidOperationException("Validation manifests require the producing corpus root.")
            }
            let manifest = ValidationManifest{
                AppId: context.App.Id,
                Translated: translated,
                IsTestProject: context.IsTestProject,
                IsAnalyzerProject: context.IsAnalyzerProject,
                IsAnalyzerTestProject: context.IsAnalyzerTestProject,
                RootNamespace: context.RootNamespace,
                AssemblyName: context.AssemblyName,
                SourceRoot: sourceRoot,
                SourceProjectPath: Relativize(sourceRoot, CanonicalRootPath.Resolve(context.App.ProjectPath))
            }
            ResolveWithinRoot(sourceRoot, manifest.SourceProjectPath)
            for friend in context.GeneratedFriendAssemblies {
                manifest.GeneratedFriendAssemblies.Add(friend)
            }
            manifest.GeneratedFriendAssemblies.Sort(StringComparer.Ordinal)
            let seenReferences = HashSet[string](StringComparer.OrdinalIgnoreCase)
            for reference in context.ExternalReferencePaths {
                if !string.IsNullOrEmpty(reference) && seenReferences.Add(reference) {
                    manifest.ExternalReferences.Add(reference)
                }
            }
            for file in context.EmittedFiles {
                let csFilePath string? = CanonicalRootPath.Resolve(file.CsFilePath)
                if string.IsNullOrEmpty(csFilePath) {
                    throw InvalidOperationException("Validation file '${file.GsPath}' has no original source identity.")
                }
                let relativeCsPath = Relativize(sourceRoot, csFilePath)
                ResolveWithinRoot(sourceRoot, relativeCsPath)
                manifest.EmittedFiles.Add(
                    ValidationManifestFile{
                        Path: Relativize(root, file.GsPath),
                        RelativeGsPath: file.RelativeGsPath,
                        CsFilePath: csFilePath,
                        RelativeCsPath: relativeCsPath,
                        FromReferencedProject: file.IsFromReferencedProject,
                        GeneratedSource: file.GeneratedSource
                    }
                )
            }
            return manifest
        }

        /// Writes the manifest into an app's artifact directory.
        /// @param manifest The manifest to write.
        /// @param artifactDir The app's artifact directory.
        func Write(manifest ValidationManifest?, artifactDir string) {
            if manifest == nil {
                throw ArgumentNullException("manifest")
            }
            Directory.CreateDirectory(artifactDir)
            File.WriteAllText(
                Path.Combine(artifactDir, FileName),
                JsonSerializer.Serialize(manifest, TriageSerialization.Options)
            )
        }

        /// Reads a manifest from an app's artifact directory.
        /// @param artifactDir The app's artifact directory.
        /// @returns The manifest, or `null` when absent or unreadable.
        func Read(artifactDir string) ValidationManifest? {
            let path = Path.Combine(artifactDir ?? string.Empty, FileName)
            if !File.Exists(path) {
                return nil
            }
            try {
                return JsonSerializer.Deserialize[ValidationManifest](
                    File.ReadAllText(path),
                    TriageSerialization.Options
                )
            } catch (JsonException) {
                return nil
            } catch (IOException) {
                return nil
            }
        }

        private func SourceRelativePath(producingRoot string?, original string?) string {
            let root string? = Normalize(producingRoot)
            let prefix = root?.TrimEnd('/') + "/"
            let path string? = Normalize(original)
            if string.IsNullOrEmpty(root) ||
                !(
                root!!.StartsWith("/", StringComparison.Ordinal) ||
                    (root!!.Length > 2 && char.IsLetter(root!![0]) && root!![1] == ':' && root!![2] == '/')
            ) ||
                root!!.Contains('\u0000', StringComparison.Ordinal) || root!!.Split('/').Any(
                (segment string) -> segment == "." || segment == ".."
            ) ||
                !path!!
                .StartsWith(prefix, ProducingPathComparison(root)) {
                throw InvalidOperationException(
                    "Validation source '$original' is outside producing corpus '$producingRoot'."
                )
            }
            let relative = path!![prefix.Length ..]
            ValidateRelativePath(relative)
            return relative
        }

        private func ResolveWithinRoot(root string?, relative string?) string? {
            var relative = relative
            relative = Normalize(relative)
            ValidateRelativePath(relative)
            let canonicalRoot string? = CanonicalRootPath.Resolve(root)
            let path string? = CanonicalRootPath.Resolve(Path.Combine(canonicalRoot!!, relative!!))
            ValidateRelativePath(Relativize(canonicalRoot, path))
            return path
        }

        private func ValidateRelativePath(relative string?) {
            if string.IsNullOrEmpty(relative) || relative!!.StartsWith("/", StringComparison.Ordinal) ||
                relative!!.Contains(':', StringComparison.Ordinal) || relative!!.Split('/').Any(
                (segment string) -> segment == "" || segment == "." || segment == ".."
            ) {
                throw InvalidOperationException("Invalid corpus-relative validation path '$relative'.")
            }
        }

        private func Normalize(path string?) string? -> path?.Replace('\\', '/')

        private func ProducingPathComparison(path string?) StringComparison -> if path!!.StartsWith(
            "//",
            StringComparison.Ordinal
        ) ||
            (path!!.Length > 2 && char.IsLetter(path!![0]) && path!![1] == ':' && path!![2] == '/') {
            StringComparison.OrdinalIgnoreCase
        } else {
            StringComparison.Ordinal
        }

        private func Relativize(root string?, path string?) string {
            let full = Path.GetFullPath(path!!)
            let relative = Path.GetRelativePath(root!!, full)
            return relative.Replace('\\', '/')
        }
    }
}

/// One emitted G# file recorded in a (cref:ValidationManifest).
class ValidationManifestFile {
    /// Gets or sets the migrated-tree-relative path of the emitted `.gs` file.
    @JsonPropertyName("path")
    @JsonPropertyOrder(int32(0))
    prop Path string

    /// Gets or sets the run-relative path used in triage artifacts.
    @JsonPropertyName("relativeGsPath")
    @JsonPropertyOrder(int32(1))
    prop RelativeGsPath string

    /// Gets or sets the originating C# file path.
    @JsonPropertyName("csFilePath")
    @JsonPropertyOrder(int32(2))
    prop CsFilePath string?

    /// Gets or sets a value indicating whether the file came from a referenced project.
    @JsonPropertyName("fromReferencedProject")
    @JsonPropertyOrder(int32(3))
    prop FromReferencedProject bool

    /// Gets or sets the corpus-relative original source path; absent in legacy manifests.
    @JsonPropertyName("relativeCsPath")
    @JsonPropertyOrder(int32(4))
    prop RelativeCsPath string?

    /// Gets or sets captured build-generated source evidence; absent for authored and old inputs.
    @JsonPropertyName("generatedSource")
    @JsonPropertyOrder(int32(5))
    @JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)
    prop GeneratedSource GeneratedValidationSource?
}

/// The actual text of a retained build-generated compilation input, not a
/// recipe for regenerating it in the validator's configuration.
class GeneratedValidationSource {
    /// Gets or sets the corpus-relative project that contributed this compilation input.
    @JsonPropertyName("sourceProjectPath")
    prop SourceProjectPath string

    /// Gets or sets the producing syntax tree's complete source text.
    @JsonPropertyName("text")
    prop Text string?

    /// Gets or sets SHA-256 of the UTF-8 source text, without an encoding preamble.
    @JsonPropertyName("sha256")
    prop Sha256 string

    internal func Validate() {
        if this.Text == nil || !string.Equals(this.Sha256, Hash(this.Text), StringComparison.Ordinal) {
            throw InvalidOperationException("Generated validation source text is absent or its SHA-256 disagrees.")
        }
    }

    shared {
        internal func Capture(
            text string,
            sourceProjectPath string
        ) GeneratedValidationSource -> GeneratedValidationSource{
            SourceProjectPath: sourceProjectPath,
            Text: text,
            Sha256: Hash(text)
        }

        private func Hash(text string?) string -> Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text!!)))
    }
}
