// <copyright file="HotReloadAgent.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Gsharp.HotReload.Runtime;

/// <summary>
/// Starts G#'s runtime-side hot-reload worker for assemblies built by
/// Gsharp.NET.Sdk.
/// </summary>
public static class HotReloadAgent
{
    private static readonly ConcurrentDictionary<string, Lazy<ProjectAgent>> Agents = new(
        OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal);
    private static readonly ConcurrentDictionary<string, string> ManifestPaths =
        new(StringComparer.OrdinalIgnoreCase);
    private static int assemblyLoadHookInitialized;

    /// <summary>
    /// Registers an assembly and its build manifest when launched under
    /// <c>dotnet watch</c>.
    /// </summary>
    /// <param name="assembly">Assembly containing the generated module initializer.</param>
    /// <param name="manifestPath">Absolute path of the SDK-generated project manifest.</param>
    public static void Start(Assembly assembly, string manifestPath)
    {
        ArgumentNullException.ThrowIfNull(assembly);

        if (!IsEnabled(Environment.GetEnvironmentVariable("DOTNET_WATCH")))
        {
            return;
        }

        if (!MetadataUpdater.IsSupported)
        {
            WriteDiagnostic("GSHR1000: runtime metadata updates are unavailable. Set DOTNET_MODIFIABLE_ASSEMBLIES=debug and use .NET 10 or newer.");
            return;
        }

        try
        {
            if (!Path.IsPathRooted(manifestPath))
            {
                manifestPath = Path.Combine(
                    Path.GetDirectoryName(assembly.Location) ?? AppContext.BaseDirectory,
                    manifestPath);
            }

            manifestPath = Path.GetFullPath(manifestPath);
            var manifest = HotReloadManifest.Load(manifestPath);
            if (!string.Equals(assembly.GetName().Name, manifest.AssemblyName, StringComparison.Ordinal))
            {
                WriteDiagnostic(
                    $"GSHR1000: manifest '{manifestPath}' targets '{manifest.AssemblyName}', not assembly '{assembly.GetName().Name}'.");
                return;
            }

            var guardName = "GsharpHotReload_" +
                Environment.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture) +
                "_" +
                Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(manifest.ProjectPath)));
            var processGuard = new Mutex(initiallyOwned: false, guardName, out var createdNew);
            if (!createdNew)
            {
                processGuard.Dispose();
                return;
            }

            try
            {
                var agent = Agents.GetOrAdd(
                    manifestPath,
                    _ => new Lazy<ProjectAgent>(
                        () =>
                        {
                            var newAgent = new ProjectAgent(assembly, manifest, processGuard);
                            newAgent.Start();
                            return newAgent;
                        },
                        LazyThreadSafetyMode.ExecutionAndPublication)).Value;
                if (!ReferenceEquals(agent.ProcessGuard, processGuard))
                {
                    processGuard.Dispose();
                }

                DiscoverSiblingManifests(Path.GetDirectoryName(manifestPath) ?? AppContext.BaseDirectory);
            }
            catch
            {
                processGuard.Dispose();
                throw;
            }
        }
        catch (Exception ex) when (ex is not OutOfMemoryException and not StackOverflowException)
        {
            WriteDiagnostic($"GSHR1000: failed to start hot reload: {ex.Message}");
        }
    }

    private static void DiscoverSiblingManifests(string directory)
    {
        try
        {
            foreach (var path in Directory.EnumerateFiles(directory, "*.manifest", SearchOption.TopDirectoryOnly))
            {
                try
                {
                    var manifest = HotReloadManifest.Load(path);
                    ManifestPaths.TryAdd(manifest.AssemblyName, path);
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or FormatException)
                {
                    WriteDiagnostic($"GSHR1000: ignored invalid hot-reload manifest '{path}': {ex.Message}");
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            WriteDiagnostic($"GSHR1000: failed to discover project manifests under '{directory}': {ex.Message}");
            return;
        }

        if (Interlocked.Exchange(ref assemblyLoadHookInitialized, 1) == 0)
        {
            AppDomain.CurrentDomain.AssemblyLoad += (_, args) => TryStartDiscoveredAssembly(args.LoadedAssembly);
        }

        foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
        {
            TryStartDiscoveredAssembly(assembly);
        }
    }

    private static void TryStartDiscoveredAssembly(Assembly assembly)
    {
        var assemblyName = assembly.GetName().Name;
        if (assemblyName != null && ManifestPaths.TryGetValue(assemblyName, out var manifestPath))
        {
            Start(assembly, manifestPath);
        }
    }

    private static bool IsEnabled(string? value) =>
        string.Equals(value, "1", StringComparison.OrdinalIgnoreCase) ||
        string.Equals(value, "true", StringComparison.OrdinalIgnoreCase);

    private static void WriteDiagnostic(string message) =>
        Console.Error.WriteLine($"G# hot reload: {message}");

    private sealed class ProjectAgent : IDisposable
    {
        private const int DebounceMilliseconds = 175;

        private readonly Assembly assembly;
        private readonly HotReloadManifest manifest;
        private readonly HotReloadDeltaBuilder deltaBuilder;
        private readonly Mutex processGuard;
        private readonly string updateDirectory;
        private readonly List<FileSystemWatcher> watchers = new();
        private readonly SemaphoreSlim updateGate = new(1, 1);
        private readonly Timer debounceTimer;
        private int requestedVersion;
        private int processedVersion;
        private bool disabled;

        public ProjectAgent(Assembly assembly, HotReloadManifest manifest, Mutex processGuard)
        {
            this.assembly = assembly;
            this.manifest = manifest;
            this.processGuard = processGuard;
            this.deltaBuilder = new HotReloadDeltaBuilder(File.ReadAllBytes(assembly.Location));
            this.updateDirectory = Path.Combine(
                manifest.UpdateDirectory,
                Environment.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture));
            this.debounceTimer = new Timer(_ => _ = Task.Run(this.ProcessChangesAsync), null, Timeout.Infinite, Timeout.Infinite);
        }

        public Mutex ProcessGuard => this.processGuard;

        private static StringComparer PathComparer =>
            OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;

        private static StringComparison PathComparison =>
            OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;

        public void Start()
        {
            this.AddWatcher(this.manifest.ProjectDirectory, includeSubdirectories: true);

            foreach (var directory in this.manifest.WatchedFiles.Keys
                .Select(Path.GetDirectoryName)
                .OfType<string>()
                .Where(path => path.Length != 0)
                .Distinct(PathComparer))
            {
                if (!IsUnderDirectory(directory, this.manifest.ProjectDirectory))
                {
                    this.AddWatcher(directory, includeSubdirectories: false);
                }
            }

            WriteDiagnostic($"watching '{this.manifest.ProjectPath}'");
            if (this.manifest.HasChangesSinceBuild())
            {
                this.QueueUpdate();
            }
        }

        public void Dispose()
        {
            foreach (var watcher in this.watchers)
            {
                watcher.Dispose();
            }

            this.debounceTimer.Dispose();
            this.updateGate.Dispose();
            this.processGuard.Dispose();
            GC.SuppressFinalize(this);
        }

        private void AddWatcher(string directory, bool includeSubdirectories)
        {
            if (!Directory.Exists(directory))
            {
                return;
            }

            var watcher = new FileSystemWatcher(directory)
            {
                IncludeSubdirectories = includeSubdirectories,
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size,
                EnableRaisingEvents = false,
            };
            watcher.Changed += (_, args) => this.OnFileChanged(args.FullPath);
            watcher.Created += (_, args) => this.OnFileChanged(args.FullPath);
            watcher.Deleted += (_, args) => this.OnFileChanged(args.FullPath);
            watcher.Renamed += (_, args) =>
            {
                this.OnFileChanged(args.OldFullPath);
                this.OnFileChanged(args.FullPath);
            };
            watcher.EnableRaisingEvents = true;
            this.watchers.Add(watcher);
        }

        private void OnFileChanged(string path)
        {
            if (this.disabled || this.IsExcluded(path) || !this.IsRelevant(path))
            {
                return;
            }

            this.QueueUpdate();
        }

        private bool IsRelevant(string path)
        {
            if (this.manifest.WatchedFiles.ContainsKey(path))
            {
                return true;
            }

            var extension = Path.GetExtension(path);
            return extension.Equals(".gs", StringComparison.OrdinalIgnoreCase) ||
                extension.Equals(".cs", StringComparison.OrdinalIgnoreCase) ||
                extension.Equals(".gsproj", StringComparison.OrdinalIgnoreCase) ||
                extension.Equals(".props", StringComparison.OrdinalIgnoreCase) ||
                extension.Equals(".targets", StringComparison.OrdinalIgnoreCase) ||
                extension.Equals(".xaml", StringComparison.OrdinalIgnoreCase) ||
                extension.Equals(".axaml", StringComparison.OrdinalIgnoreCase) ||
                extension.Equals(".resx", StringComparison.OrdinalIgnoreCase) ||
                extension.Equals(".editorconfig", StringComparison.OrdinalIgnoreCase);
        }

        private bool IsExcluded(string path) =>
            IsUnderDirectory(path, this.manifest.IntermediateDirectory) ||
            IsUnderDirectory(path, this.manifest.OutputDirectory) ||
            IsUnderDirectory(path, this.manifest.UpdateDirectory);

        private static bool IsUnderDirectory(string path, string directory)
        {
            if (string.IsNullOrEmpty(directory))
            {
                return false;
            }

            var normalizedDirectory = Path.GetFullPath(directory);
            if (!Path.EndsInDirectorySeparator(normalizedDirectory))
            {
                normalizedDirectory += Path.DirectorySeparatorChar;
            }

            return Path.GetFullPath(path).StartsWith(normalizedDirectory, PathComparison);
        }

        private void QueueUpdate()
        {
            Interlocked.Increment(ref this.requestedVersion);
            this.debounceTimer.Change(DebounceMilliseconds, Timeout.Infinite);
        }

        private async Task ProcessChangesAsync()
        {
            await this.updateGate.WaitAsync().ConfigureAwait(false);
            try
            {
                while (!this.disabled)
                {
                    var targetVersion = Volatile.Read(ref this.requestedVersion);
                    if (targetVersion == this.processedVersion)
                    {
                        return;
                    }

                    await this.CompileAndApplyAsync().ConfigureAwait(false);
                    this.processedVersion = targetVersion;
                }
            }
            catch (Exception ex)
            {
                this.disabled = true;
                WriteDiagnostic($"GSHR1003: hot-reload worker stopped after an unexpected failure: {ex}");
            }
            finally
            {
                this.updateGate.Release();
            }
        }

        private async Task CompileAndApplyAsync()
        {
            Directory.CreateDirectory(this.updateDirectory);
            var intermediateDirectory = EnsureTrailingDirectorySeparator(
                Path.Combine(this.updateDirectory, "obj"));
            var outputDirectory = EnsureTrailingDirectorySeparator(
                Path.Combine(this.updateDirectory, "bin"));

            var startInfo = new ProcessStartInfo("dotnet")
            {
                WorkingDirectory = this.manifest.ProjectDirectory,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            startInfo.ArgumentList.Add("msbuild");
            startInfo.ArgumentList.Add(this.manifest.ProjectPath);
            startInfo.ArgumentList.Add("-nologo");
            startInfo.ArgumentList.Add("-v:minimal");
            startInfo.ArgumentList.Add("-nodeReuse:false");
            startInfo.ArgumentList.Add("-t:_GsharpHotReloadCompile");
            startInfo.ArgumentList.Add($"-p:TargetFramework={this.manifest.TargetFramework}");
            startInfo.ArgumentList.Add($"-p:Configuration={this.manifest.Configuration}");
            startInfo.ArgumentList.Add("-p:GsharpEnableHotReload=true");
            startInfo.ArgumentList.Add("-p:BuildProjectReferences=false");
            startInfo.ArgumentList.Add($"-p:IntermediateOutputPath={intermediateDirectory}");
            startInfo.ArgumentList.Add($"-p:OutputPath={outputDirectory}");
            startInfo.ArgumentList.Add($"-p:GsharpHotReloadOutputDirectory={this.updateDirectory}");

            using var process = Process.Start(startInfo);
            if (process == null)
            {
                WriteDiagnostic("GSHR1004: failed to launch MSBuild for delta compilation.");
                return;
            }

            var standardOutput = process.StandardOutput.ReadToEndAsync();
            var standardError = process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync().ConfigureAwait(false);
            var output = await standardOutput.ConfigureAwait(false);
            var error = await standardError.ConfigureAwait(false);

            if (process.ExitCode != 0)
            {
                WriteDiagnostic($"GSHR1004: delta compilation failed for '{this.manifest.ProjectPath}'.");
                WriteCompilerOutput(output, error);
                return;
            }

            var assemblyPath = Path.Combine(this.updateDirectory, this.manifest.AssemblyName + ".dll");
            if (!File.Exists(assemblyPath))
            {
                WriteDiagnostic($"GSHR1004: delta compilation did not produce '{assemblyPath}'.");
                WriteCompilerOutput(output, error);
                return;
            }

            var update = this.deltaBuilder.CreateUpdate(await File.ReadAllBytesAsync(assemblyPath).ConfigureAwait(false));
            switch (update.Status)
            {
                case HotReloadDeltaStatus.NoChanges:
                    return;
                case HotReloadDeltaStatus.Unsupported:
                    WriteDiagnostic(update.Diagnostic ?? "GSHR1001: unsupported edit. Restart required.");
                    return;
                case HotReloadDeltaStatus.Ready:
                    try
                    {
                        MetadataUpdater.ApplyUpdate(
                            this.assembly,
                            update.MetadataDelta,
                            update.IlDelta,
                            update.PdbDelta);
                        update.Commit();
                        WriteDiagnostic(
                            $"applied {update.UpdatedMethods.Length} method update(s) to '{this.assembly.GetName().Name}': {string.Join(", ", update.UpdatedMethods)}");
                    }
                    catch (Exception ex) when (ex is InvalidOperationException or NotSupportedException or ArgumentException)
                    {
                        this.disabled = true;
                        WriteDiagnostic($"GSHR1003: runtime rejected delta for '{this.manifest.ProjectPath}': {ex.Message}");
                    }

                    return;
            }
        }

        private static string EnsureTrailingDirectorySeparator(string path) =>
            Path.EndsInDirectorySeparator(path) ? path : path + Path.DirectorySeparatorChar;

        private static void WriteCompilerOutput(string output, string error)
        {
            if (!string.IsNullOrWhiteSpace(output))
            {
                Console.Error.WriteLine(output.TrimEnd());
            }

            if (!string.IsNullOrWhiteSpace(error))
            {
                Console.Error.WriteLine(error.TrimEnd());
            }
        }
    }
}
