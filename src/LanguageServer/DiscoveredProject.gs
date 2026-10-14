// <copyright file="DiscoveredProject.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer

import System
import System.Collections.Generic

/// Represents a discovered project with its source files.
class DiscoveredProject {
    /// Initializes a new instance of the (cref:DiscoveredProject) class.
    /// @param projectFilePath Absolute path to the `.gsproj` file.
    /// @param sourceFiles Absolute paths to all `.gs` source files in the project.
    /// @param projectReferences Absolute paths to referenced `.gsproj` files.
    /// @param references Absolute paths to assembly references (from the MSBuild-emitted response file).
    /// @param referenceSourcePath Absolute path to the `.rsp` the references were parsed from, or `null`
    /// when none was found.
    /// @param assemblyName The project's effective `AssemblyName` (i.e. the basename of the output DLL).
    /// Used by cross-project navigation to map an imported symbol's declaring assembly back to the owning
    /// project.
    /// @param targetFramework The project's target framework moniker (e.g. `net10.0`), parsed from the
    /// `.gsproj`; may be `null` when undeclared or unparseable.
    /// @param rootNamespace The project's effective `RootNamespace` (ADR-0142, issue #2200), used
    /// as the base namespace when generating a `.resx`'s codebehind class.
    /// Defaults to (cref:AssemblyName) when undeclared, mirroring MSBuild.
    init(
        projectFilePath string,
        sourceFiles IReadOnlyList[string],
        projectReferences IReadOnlyList[string],
        references IReadOnlyList[string]? = nil,
        referenceSourcePath string? = nil,
        assemblyName string? = nil,
        targetFramework string? = nil,
        rootNamespace string? = nil
    ) {
        ProjectFilePath = projectFilePath
        SourceFiles = sourceFiles
        ProjectReferences = projectReferences
        References = references ?? Array.Empty[string]()
        ReferenceSourcePath = referenceSourcePath
        AssemblyName = assemblyName
        TargetFramework = targetFramework
        RootNamespace = rootNamespace
    }

    /// Gets the absolute path to the `.gsproj` file.
    prop ProjectFilePath string {
        get;
    }

    /// Gets the absolute paths to all `.gs` source files in the project.
    prop SourceFiles IReadOnlyList[string] {
        get;
    }

    /// Gets the absolute paths to referenced `.gsproj` files.
    prop ProjectReferences IReadOnlyList[string] {
        get;
    }

    /// Gets the absolute paths to assembly references (NuGet packages, transitive
    /// dependencies, and the ref-assembly outputs of non-G# (cref:ProjectReferences)),
    /// parsed from the MSBuild-emitted response file. Empty when no `.rsp` has been
    /// produced yet (e.g. the project has never been built or restored).
    prop References IReadOnlyList[string] {
        get;
    }

    /// Gets the absolute path to the `.rsp` file the references were parsed from,
    /// or `null` if no response file was located. The path is used by
    /// (cref:ProjectState) to invalidate cached resolvers when the file is
    /// rewritten by a subsequent build.
    prop ReferenceSourcePath string? {
        get;
    }

    /// Gets the project's effective `AssemblyName` — the basename of the
    /// output DLL (without extension) the SDK will emit for this project. Used
    /// by cross-project Go-to-Definition (`WorkspaceState.TryGetProjectByOutputAssembly`)
    /// to map an imported symbol's declaring assembly back to the owning
    /// sibling project. May be `null` when the project file could not be
    /// parsed; in that case the consumer typically falls back to the project
    /// file's basename.
    prop AssemblyName string? {
        get;
    }

    /// Gets the project's target framework moniker (e.g. `net10.0`), parsed
    /// from the `.gsproj`'s `<TargetFramework>` (or raw
    /// `<TargetFrameworks>`) element. May be `null` or empty when
    /// neither is declared or the file could not be parsed. Surfaced to the VS Code
    /// Test Explorer so test groups can be labelled `<project> (<tfm>)`.
    prop TargetFramework string? {
        get;
    }

    /// Gets the project's effective `RootNamespace` (ADR-0142, issue #2200) —
    /// the base namespace the resx codebehind generator prefixes with the resx's
    /// folder path relative to the project root. Falls back to
    /// (cref:AssemblyName) when the `.gsproj` declares no
    /// `<RootNamespace>`, matching MSBuild's own default.
    prop RootNamespace string? {
        get;
    }
}
