// <copyright file="HotReloadAgent.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.HotReload.Runtime

import System
import System.Collections.Concurrent
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics
import System.Globalization
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Security.Cryptography
import System.Text
import System.Threading
import System.Threading.Tasks

/// Starts G#'s runtime-side hot-reload worker for assemblies built by
/// Gsharp.NET.Sdk.
shared class HotReloadAgent {
    private class ProjectAgent : IDisposable {
        private let assembly Assembly
        private let manifest HotReloadManifest
        private let deltaBuilder HotReloadDeltaBuilder
        private let processGuard Mutex
        private let updateDirectory string
        private let watchers List[FileSystemWatcher] = List[FileSystemWatcher]()
        private let updateGate SemaphoreSlim = SemaphoreSlim(1, 1)
        private let debounceTimer Timer
        private var requestedVersion int32
        private var processedVersion int32
        private var disabled bool

        init(assembly Assembly, manifest HotReloadManifest, processGuard Mutex) {
            this.assembly = assembly
            this.manifest = manifest
            this.processGuard = processGuard
            this.deltaBuilder = HotReloadDeltaBuilder(File.ReadAllBytes(assembly.Location))
            this.updateDirectory = Path.Combine(
                manifest.UpdateDirectory,
                Environment.ProcessId.ToString(CultureInfo.InvariantCulture)
            )
            this.debounceTimer = Timer(
                (__underscore object?) -> {
                    Task.Run(this.ProcessChangesAsync)
                },
                nil,
                Timeout.Infinite,
                Timeout.Infinite
            )
            HotReloadAgent.EnsureMetadataUpdateHandlerHook()
        }

        prop ProcessGuard Mutex -> this.processGuard

        func Start() {
            this.AddWatcher(this.manifest.ProjectDirectory, includeSubdirectories: true)
            for directory in this
                .manifest
                .WatchedFiles
                .Keys
                .Select(Path.GetDirectoryName)
                .OfType[string]()
                .Where((path string) -> path.Length != 0)
                .Distinct(PathComparer) {
                if !IsUnderDirectory(directory, this.manifest.ProjectDirectory) {
                    this.AddWatcher(directory, includeSubdirectories: false)
                }
            }
            HotReloadAgent.WriteDiagnostic("watching '${this.manifest.ProjectPath}'")
            if this.manifest.HasChangesSinceBuild() {
                this.QueueUpdate()
            }
        }

        func Dispose() {
            for watcher in this.watchers {
                watcher.Dispose()
            }
            this.debounceTimer.Dispose()
            this.updateGate.Dispose()
            this.processGuard.Dispose()
            GC.SuppressFinalize(this)
        }

        private func AddWatcher(directory string, includeSubdirectories bool) {
            if !Directory.Exists(directory) {
                return
            }
            let watcher = FileSystemWatcher(directory){
                IncludeSubdirectories = includeSubdirectories,
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size,
                EnableRaisingEvents = false
            }
            watcher.Changed += (_ object, args FileSystemEventArgs) -> this.OnFileChanged(args.FullPath)
            watcher.Created += (_ object, args FileSystemEventArgs) -> this.OnFileChanged(args.FullPath)
            watcher.Deleted += (_ object, args FileSystemEventArgs) -> this.OnFileChanged(args.FullPath)
            watcher.Renamed += (_ object, args RenamedEventArgs) -> {
                this.OnFileChanged(args.OldFullPath)
                this.OnFileChanged(args.FullPath)
            }
            watcher.EnableRaisingEvents = true
            this.watchers.Add(watcher)
        }

        private func OnFileChanged(path string) {
            if this.disabled || this.IsExcluded(path) || !this.IsRelevant(path) {
                return
            }
            this.QueueUpdate()
        }

        private func IsRelevant(path string) bool {
            if this.manifest.WatchedFiles.ContainsKey(path) {
                return true
            }
            let extension = Path.GetExtension(path)
            return extension.Equals(".gs", StringComparison.OrdinalIgnoreCase) || extension.Equals(
                ".cs",
                StringComparison.OrdinalIgnoreCase
            ) ||
                extension.Equals(".gsproj", StringComparison.OrdinalIgnoreCase) || extension.Equals(
                ".props",
                StringComparison.OrdinalIgnoreCase
            ) ||
                extension.Equals(".targets", StringComparison.OrdinalIgnoreCase) || extension.Equals(
                ".xaml",
                StringComparison.OrdinalIgnoreCase
            ) ||
                extension.Equals(".axaml", StringComparison.OrdinalIgnoreCase) || extension.Equals(
                ".resx",
                StringComparison.OrdinalIgnoreCase
            ) ||
                extension.Equals(".editorconfig", StringComparison.OrdinalIgnoreCase)
        }

        private func IsExcluded(path string) bool -> IsUnderDirectory(path, this.manifest.IntermediateDirectory) ||
            IsUnderDirectory(path, this.manifest.OutputDirectory) ||
            IsUnderDirectory(path, this.manifest.UpdateDirectory)

        private func QueueUpdate() {
            Interlocked.Increment(&this.requestedVersion)
            this.debounceTimer.Change(DebounceMilliseconds, Timeout.Infinite)
        }

        private async func ProcessChangesAsync() {
            await this.updateGate.WaitAsync().ConfigureAwait(false)
            try {
                while !this.disabled {
                    let targetVersion = Volatile.Read(&this.requestedVersion)
                    if targetVersion == this.processedVersion {
                        return
                    }
                    await this.CompileAndApplyAsync().ConfigureAwait(false)
                    this.processedVersion = targetVersion
                }
            } catch (ex Exception) {
                this.disabled = true
                HotReloadAgent.WriteDiagnostic("GSHR1003: hot-reload worker stopped after an unexpected failure: $ex")
            } finally {
                this.updateGate.Release()
            }
        }

        private async func CompileAndApplyAsync() {
            Directory.CreateDirectory(this.updateDirectory)
            // dotnet-watch excludes agent-owned inputs, and updateGate permits
            // one build per project, so reuse normal obj/ reference paths safely.
            let startInfo = ProcessStartInfo("dotnet"){
                WorkingDirectory = this.manifest.ProjectDirectory,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            }
            startInfo.ArgumentList.Add("msbuild")
            startInfo.ArgumentList.Add(this.manifest.ProjectPath)
            startInfo.ArgumentList.Add("-nologo")
            startInfo.ArgumentList.Add("-v:minimal")
            startInfo.ArgumentList.Add("-nodeReuse:false")
            startInfo.ArgumentList.Add("-t:_GsharpHotReloadCompile")
            startInfo.ArgumentList.Add("-p:TargetFramework=${this.manifest.TargetFramework}")
            startInfo.ArgumentList.Add("-p:Configuration=${this.manifest.Configuration}")
            startInfo.ArgumentList.Add("-p:GsharpEnableHotReload=true")
            startInfo.ArgumentList.Add("-p:BuildProjectReferences=false")
            startInfo.ArgumentList.Add("-p:GsharpHotReloadOutputDirectory=${this.updateDirectory}")
            using let process Process? = Process.Start(startInfo)
            if process == nil {
                HotReloadAgent.WriteDiagnostic("GSHR1004: failed to launch MSBuild for delta compilation.")
                return
            }
            let standardOutput = process.StandardOutput.ReadToEndAsync()
            let standardError = process.StandardError.ReadToEndAsync()
            await process.WaitForExitAsync().ConfigureAwait(false)
            let output = await standardOutput.ConfigureAwait(false)
            let error = await standardError.ConfigureAwait(false)
            if process.ExitCode != 0 {
                HotReloadAgent.WriteDiagnostic("GSHR1004: delta compilation failed for '${this.manifest.ProjectPath}'.")
                WriteCompilerOutput(output, error)
                return
            }
            let assemblyPath = Path.Combine(this.updateDirectory, this.manifest.AssemblyName + ".dll")
            if !File.Exists(assemblyPath) {
                HotReloadAgent.WriteDiagnostic("GSHR1004: delta compilation did not produce '$assemblyPath'.")
                WriteCompilerOutput(output, error)
                return
            }
            let update = this.deltaBuilder.CreateUpdate(
                await File.ReadAllBytesAsync(assemblyPath).ConfigureAwait(false)
            )
            switch update.Status {
                case HotReloadDeltaStatus.NoChanges {
                    return
                }
                case HotReloadDeltaStatus.Unsupported {
                    HotReloadAgent.WriteDiagnostic(update.Diagnostic ?? "GSHR1001: unsupported edit. Restart required.")
                    return
                }
                case HotReloadDeltaStatus.Ready {
                    // Each project has its own agent, so serialize applying a
                    // delta and running the handlers process-wide, as
                    // dotnet watch applies one update at a time: two updates'
                    // handler phases never interleave. The gate is awaited,
                    // never blocked on, and only update pipelines take it.
                    await HotReloadAgent.MetadataUpdateGate.WaitAsync().ConfigureAwait(false)
                    try {
                        if this.TryApplyUpdate(update) {
                            HotReloadAgent.MetadataUpdateHandlers.MetadataUpdated(
                                HotReloadAgent.ResolveUpdatedTypes(this.assembly, update.UpdatedTypes)
                            )
                        }
                    } finally {
                        HotReloadAgent.MetadataUpdateGate.Release()
                    }
                    return
                }
            }
        }

        private func TryApplyUpdate(update HotReloadDelta) bool {
            try {
                MetadataUpdater.ApplyUpdate(this.assembly, update.MetadataDelta, update.IlDelta, update.PdbDelta)
                update.Commit()
                HotReloadAgent.WriteDiagnostic(
                    "applied ${update.UpdatedMethods.Length} method update(s) to '${this.assembly.GetName().Name}': ${string.Join(", ", update.UpdatedMethods)}"
                )
                return true
            } catch (ex Exception) when ex is InvalidOperationException ||
                ex is NotSupportedException ||
                ex is ArgumentException {
                this.disabled = true
                HotReloadAgent.WriteDiagnostic(
                    "GSHR1003: runtime rejected delta for '${this.manifest.ProjectPath}': ${ex.Message}"
                )
                return false
            }
        }

        shared {
            private const DebounceMilliseconds int32 = 175
            private prop PathComparer StringComparer -> if OperatingSystem.IsWindows() {
                StringComparer.OrdinalIgnoreCase
            } else {
                StringComparer.Ordinal
            }
            private prop PathComparison StringComparison -> if OperatingSystem.IsWindows() {
                StringComparison.OrdinalIgnoreCase
            } else {
                StringComparison.Ordinal
            }

            private func IsUnderDirectory(path string, directory string) bool {
                if string.IsNullOrEmpty(directory) {
                    return false
                }
                var normalizedDirectory = Path.GetFullPath(directory)
                if !Path.EndsInDirectorySeparator(normalizedDirectory) {
                    normalizedDirectory += Path.DirectorySeparatorChar
                }
                return Path.GetFullPath(path).StartsWith(normalizedDirectory, PathComparison)
            }

            private func WriteCompilerOutput(output string, error string) {
                if !string.IsNullOrWhiteSpace(output) {
                    Console.Error.WriteLine(output.TrimEnd())
                }
                if !string.IsNullOrWhiteSpace(error) {
                    Console.Error.WriteLine(error.TrimEnd())
                }
            }
        }
    }

    private let Agents ConcurrentDictionary[string, Lazy[ProjectAgent]] = ConcurrentDictionary[
        string,
        Lazy[ProjectAgent]
    ](
        if OperatingSystem.IsWindows() {
            StringComparer.OrdinalIgnoreCase
        } else {
            StringComparer.Ordinal
        }
    )
    private let ManifestPaths ConcurrentDictionary[string, string] = ConcurrentDictionary[string, string](
        StringComparer.OrdinalIgnoreCase
    )
    private var assemblyLoadHookInitialized int32
    private let MetadataUpdateGate SemaphoreSlim = SemaphoreSlim(1, 1)
    private let MetadataUpdateHandlers MetadataUpdateHandlerInvoker = MetadataUpdateHandlerInvoker(
        (message string) -> WriteDiagnostic(message)
    )
    private var metadataUpdateHandlerHookInitialized int32

    /// Registers an assembly and its build manifest when launched under
    /// `dotnet watch`.
    /// @param assembly Assembly containing the generated module initializer.
    /// @param manifestPath Absolute path of the SDK-generated project manifest.
    func Start(assembly Assembly, manifestPath string) {
        var manifestPath = manifestPath
        ArgumentNullException.ThrowIfNull(assembly, paramName: "assembly")
        if !IsEnabled(Environment.GetEnvironmentVariable("DOTNET_WATCH")) {
            return
        }
        if !MetadataUpdater.IsSupported {
            WriteDiagnostic(
                "GSHR1000: runtime metadata updates are unavailable. Set DOTNET_MODIFIABLE_ASSEMBLIES=debug and use .NET 10 or newer."
            )
            return
        }
        try {
            if !Path.IsPathRooted(manifestPath) {
                manifestPath = Path.Combine(
                    Path.GetDirectoryName(assembly.Location) ?? AppContext.BaseDirectory,
                    manifestPath
                )
            }
            manifestPath = Path.GetFullPath(manifestPath)
            let manifest = HotReloadManifest.Load(manifestPath)
            if !string.Equals(assembly.GetName().Name, manifest.AssemblyName, StringComparison.Ordinal) {
                WriteDiagnostic(
                    "GSHR1000: manifest '$manifestPath' targets '${manifest.AssemblyName}', not assembly '${assembly.GetName().Name}'."
                )
                return
            }
            let guardName = "GsharpHotReload_" + Environment.ProcessId.ToString(CultureInfo.InvariantCulture) +
                "_" +
                Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(manifest.ProjectPath)))
            let processGuard = Mutex(initiallyOwned: false, guardName, out var createdNew)
            if !createdNew {
                processGuard.Dispose()
                return
            }
            try {
                let agent = Agents.GetOrAdd(
                    manifestPath,
                    (_ string) -> Lazy[ProjectAgent](
                        () -> {
                            let newAgent = ProjectAgent(assembly, manifest, processGuard)
                            newAgent.Start()
                            return newAgent
                        },
                        LazyThreadSafetyMode.ExecutionAndPublication
                    )
                )
                    .Value
                if !object.ReferenceEquals(agent.ProcessGuard, processGuard) {
                    processGuard.Dispose()
                }
                DiscoverSiblingManifests(Path.GetDirectoryName(manifestPath) ?? AppContext.BaseDirectory)
            } catch {
                processGuard.Dispose()
                rethrow
            }
        } catch (ex Exception) when !(ex is OutOfMemoryException) && !(ex is StackOverflowException) {
            WriteDiagnostic("GSHR1000: failed to start hot reload: ${ex.Message}")
        }
    }

    private func DiscoverSiblingManifests(directory string) {
        try {
            for path in Directory.EnumerateFiles(directory, "*.manifest", SearchOption.TopDirectoryOnly) {
                try {
                    let manifest = HotReloadManifest.Load(path)
                    ManifestPaths.TryAdd(manifest.AssemblyName, path)
                } catch (ex Exception) when ex is IOException ||
                    ex is UnauthorizedAccessException ||
                    ex is FormatException {
                    WriteDiagnostic("GSHR1000: ignored invalid hot-reload manifest '$path': ${ex.Message}")
                }
            }
        } catch (ex Exception) when ex is IOException || ex is UnauthorizedAccessException {
            WriteDiagnostic("GSHR1000: failed to discover project manifests under '$directory': ${ex.Message}")
            return
        }
        if Interlocked.Exchange(&assemblyLoadHookInitialized, 1) == 0 {
            AppDomain
                .CurrentDomain
                .AssemblyLoad += (_ object?, args AssemblyLoadEventArgs) -> TryStartDiscoveredAssembly(
                args.LoadedAssembly
            )
        }
        for assembly in AppDomain.CurrentDomain.GetAssemblies() {
            TryStartDiscoveredAssembly(assembly)
        }
    }

    private func TryStartDiscoveredAssembly(assembly Assembly) {
        let assemblyName string? = assembly.GetName().Name
        if assemblyName != nil && ManifestPaths.TryGetValue(assemblyName, out var manifestPath) {
            Start(assembly, manifestPath)
        }
    }

    /// Discards the cached metadata update handlers whenever an assembly
    /// loads, so the next update discovers handlers it brought. Installed
    /// before the first update can be applied.
    private func EnsureMetadataUpdateHandlerHook() {
        if Interlocked.Exchange(&metadataUpdateHandlerHookInitialized, 1) == 0 {
            AppDomain
                .CurrentDomain
                .AssemblyLoad += (_ object?, args AssemblyLoadEventArgs) -> MetadataUpdateHandlers.Clear()
        }
    }

    /// Resolves the TypeDef tokens of an applied delta to the types passed to
    /// metadata update handlers, reporting a token that does not resolve.
    /// @param assembly The updated assembly.
    /// @param tokens TypeDef tokens in update order.
    /// @returns The resolved types, in the same order.
    private func ResolveUpdatedTypes(assembly Assembly, tokens ImmutableArray[int32])[]Type {
        let types = List[Type](tokens.Length)
        for token in tokens {
            // Hot reload supports single-module assemblies only, so every
            // updated type is in the manifest module.
            try {
                types.Add(assembly.ManifestModule.ResolveType(token))
            } catch (ex Exception) {
                WriteDiagnostic(
                    "GSHR1005: failed to load updated type 0x${token.ToString("X8", CultureInfo.InvariantCulture)}: ${ex.Message}"
                )
            }
        }
        return types.ToArray()
    }

    private func IsEnabled(value string?) bool -> string.Equals(value, "1", StringComparison.OrdinalIgnoreCase) ||
        string.Equals(value, "true", StringComparison.OrdinalIgnoreCase)

    private func WriteDiagnostic(message string) -> Console.Error.WriteLine("G# hot reload: $message")
}
