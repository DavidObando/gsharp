// <copyright file="ReferenceClosure.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import System
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit.Sdk

/// The two reference closures gsc can be driven with, and the helpers that
/// materialise them. Extracted from `XunitAssertOverloadResolutionTests`
/// (issue #504-reopen) so issue #3717's differential conformance mode can
/// reuse exactly the same closures rather than re-deriving them.
///
/// The distinction matters because it decides which reflection context gsc
/// binds against. With no `/reference:` switch gsc resolves imports from
/// the host's trusted platform assemblies and every imported type is a live
/// runtime (cref:Type); with the `Microsoft.NETCore.App.Ref`
/// targeting-pack facades gsc constructs a
/// (cref:System.Reflection.MetadataLoadContext) — which is what every
/// real SDK build does. Defects that take the wrong arm of a
/// `typeof(X).IsAssignableFrom(clrType)` test (#3708, #3697, #3637,
/// #3636, #3666) are visible only in the second configuration.
internal enum ReferenceClosureMode {
    HostTrustedPlatform,
    ReferencePack
}

/// Resolves the reference closures described by (cref:ReferenceClosureMode).
internal shared class ReferenceClosure {
    /// Assembles the same reference closure the .NET SDK would pass to gsc —
    /// the `Microsoft.NETCore.App.Ref` targeting-pack facades for the
    /// running runtime. Each facade resolves to a different
    /// (cref:System.Reflection.Assembly) identity than the host's
    /// `System.Private.CoreLib`, so imported types are
    /// `MetadataLoadContext` types rather than runtime types.
    /// @returns The ref-pack reference assemblies.
    func RefPackAssemblies() IEnumerable[string] {
        let refDir = LocateRefPackDirectory() ??
            throw XunitException("prerequisite missing: " + (UnavailableReason ?? "ref pack not resolvable"))
        return Directory.EnumerateFiles(refDir, "*.dll")
    }

    /// The host's trusted platform assemblies — the set gsc falls back to when
    /// no `/reference:` switch is supplied.
    /// @returns Existing TPA paths.
    func TrustedPlatformAssemblies() sequence[string] {
        let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
        if tpa == nil || string.IsNullOrEmpty(tpa) {
            yield break
        }
        for path in tpa.Split(Path.PathSeparator) {
            if !string.IsNullOrWhiteSpace(path) && File.Exists(path) {
                yield path
            }
        }
    }

    /// Trusted platform assemblies whose file name starts with
    /// [`prefix`](paramref). Used to graft host-resolved packages (for
    /// example xUnit) onto the ref-pack closure; their identity is stable
    /// across both reflection contexts and is not what the differential is
    /// exercising.
    /// @param prefix Case-insensitive file-name prefix.
    /// @returns Matching TPA paths.
    func TrustedPlatformAssembliesStartingWith(prefix string) IEnumerable[string] -> TrustedPlatformAssemblies().Where(
        (path string) -> Path.GetFileName(path).StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
    )

    /// Gets a human-readable reason the ref pack could not be located, or
    /// `null` when it was found. Callers that must degrade
    /// gracefully (rather than fail) consult this before enumerating.
    prop UnavailableReason string? {
        get;
        private set;
    }

    /// Gets a value indicating whether the ref pack is present on this machine.
    /// @returns `true` when (cref:RefPackAssemblies) will succeed.
    func IsRefPackAvailable() bool -> LocateRefPackDirectory() != nil

    private func LocateRefPackDirectory() string? {
        let runtimeDir string? = Path.GetDirectoryName(typeof(object).Assembly.Location)
        if string.IsNullOrEmpty(runtimeDir) {
            return Unavailable("host runtime directory not resolvable")
        }
        let dotnetRoot string? = Directory.GetParent(runtimeDir)?.Parent?.Parent?.FullName
        if string.IsNullOrEmpty(dotnetRoot) {
            return Unavailable("dotnet root not resolvable")
        }
        let packsRoot = Path.Combine(dotnetRoot, "packs", "Microsoft.NETCore.App.Ref")
        if !Directory.Exists(packsRoot) {
            return Unavailable("ref pack root '$packsRoot' missing")
        }
        let tfm = "net${Environment.Version.Major}.0"
        // Match the targeting-pack version to the running runtime (e.g. 10.0.X).
        let refDir = Path.Combine(packsRoot, Environment.Version.ToString(3), "ref", tfm)
        if Directory.Exists(refDir) {
            UnavailableReason = nil
            return refDir
        }
        // Fall back to the newest installed ref pack matching the major version.
        let major = Environment.Version.Major.ToString()
        let candidate string? = Directory
            .EnumerateDirectories(packsRoot, major + ".*")
            .OrderByDescending((directory string) -> directory, StringComparer.Ordinal)
            .Select((directory string) -> Path.Combine(directory, "ref", tfm))
            .FirstOrDefault(Directory.Exists)
        if string.IsNullOrEmpty(candidate) {
            return Unavailable("no ref pack for net$major.0 under '$packsRoot'")
        }
        UnavailableReason = nil
        return candidate
    }

    private func Unavailable(reason string) string? {
        UnavailableReason = reason
        return nil
    }
}
