// <copyright file="DeclaredProjectItem.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Threading
import System.Threading.Tasks
import System.Xml.Linq
import Cs2Gs.Translator.Loading

/// A declared MSBuild item copied from a source project into its generated
/// G# project, including item-group conditions and all item metadata.
class DeclaredProjectItem {
    /// Initializes a new instance of the (cref:DeclaredProjectItem) class.
    /// @param itemGroupCondition The containing ItemGroup condition.
    /// @param element The namespace-free item XML.
    /// @param sourceInclude The absolute source ProjectReference target.
    /// @param sourceAssemblyName The evaluated referenced project's assembly name.
    init(itemGroupCondition string?, element XElement, sourceInclude string? = nil, sourceAssemblyName string? = nil) {
        this.ItemGroupCondition = itemGroupCondition
        this.Element = element ?? throw ArgumentNullException("element")
        this.SourceInclude = sourceInclude
        this.SourceAssemblyName = sourceAssemblyName
    }

    /// Gets the containing ItemGroup condition, or `null`.
    prop ItemGroupCondition string? {
        get;
    }

    /// Gets the namespace-free item XML.
    prop Element XElement {
        get;
    }

    /// Gets the absolute source ProjectReference target, when applicable.
    prop SourceInclude string? {
        get;
    }

    /// Gets the evaluated referenced project's assembly name, when known.
    prop SourceAssemblyName string? {
        get;
    }
}

/// Reads and rewrites declared project dependency items.
internal shared class DeclaredProjectItems {
    internal func Read(projectPath string, itemName string) IReadOnlyList[DeclaredProjectItem] {
        if string.IsNullOrEmpty(projectPath) || !File.Exists(projectPath) {
            return Array.Empty[DeclaredProjectItem]()
        }
        let document = XDocument.Load(projectPath, LoadOptions.PreserveWhitespace)
        let projectDirectory = Path.GetDirectoryName(Path.GetFullPath(projectPath))
        let items = List[DeclaredProjectItem]()
        for itemGroup in document.Descendants().Where(
            (e XElement) -> e.Name.LocalName.Equals("ItemGroup", StringComparison.OrdinalIgnoreCase)
        ) {
            let groupCondition = itemGroup.Attribute(XName?("Condition")!!)?.Value
            for item in itemGroup.Elements().Where(
                (e XElement) -> e.Name.LocalName.Equals(itemName, StringComparison.OrdinalIgnoreCase)
            ) {
                let clone = StripNamespaces(item)
                var sourceInclude string? = nil
                if itemName.Equals("ProjectReference", StringComparison.OrdinalIgnoreCase) {
                    let include = item.Attribute(XName?("Include")!!)?.Value
                    if !string.IsNullOrEmpty(include) && !IsMsbuildExpression(include) {
                        let normalizedInclude = include!!.Replace('\\', Path.DirectorySeparatorChar).Replace(
                            '/',
                            Path.DirectorySeparatorChar
                        )
                        sourceInclude = Path.GetFullPath(Path.Combine(projectDirectory!!, normalizedInclude))
                    }
                }
                items.Add(DeclaredProjectItem(groupCondition, clone, sourceInclude))
            }
        }
        return items
    }

    internal func ProjectReferencePaths(
        projectPath string,
        evaluatedProjectReferencePaths IReadOnlyList[string] = nil
    ) IReadOnlyList[string] {
        let items = Read(projectPath, "ProjectReference")
        let paths = List[string]()
        for item in items {
            if item.SourceInclude is string sourceInclude {
                paths.Add(sourceInclude)
            }
        }
        return paths
            .Concat(RequireEvaluatedProjectReferencePaths(projectPath, items, evaluatedProjectReferencePaths))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList()
    }

    internal async func EvaluateCompileProjectReferencePathsAsync(
        projectPath string,
        cancellationToken CancellationToken = default(CancellationToken)
    ) IReadOnlyList[string] {
        let loaded = await CSharpProjectLoader.LoadProjectWithReferencesAsync(projectPath, cancellationToken)
            .ConfigureAwait(false)
        // Issue #4612: a project without a path maps to the empty string the
        // next filter already drops; a null lambda result would throw in the
        // migrated G#.
        return loaded
            .Skip(1)
            .Select((project LoadedCSharpProject) -> project.ProjectPath ?? string.Empty)
            .Where((path string) -> !string.IsNullOrEmpty(path))
            .Select(Path.GetFullPath)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList()
    }

    /// Collects the absolute project paths that any of the given projects
    /// declares a compile `ProjectReference` to (issue #3645). A
    /// `ReferenceOutputAssembly="false"` reference contributes no
    /// compile-time type surface (the referencing project cannot consume the
    /// target's types), so it is excluded.
    /// @param projectPaths The referencing projects' `.csproj` paths.
    /// @param evaluatedProjectReferences Evaluated compile-reference paths keyed by referencing project.
    /// Required
    /// for projects declaring an MSBuild expression include.
    /// @returns The referenced projects' absolute paths (case-insensitive set).
    internal func CollectCompileReferencedProjectPaths(
        projectPaths IEnumerable[string],
        evaluatedProjectReferences IReadOnlyDictionary[string, IReadOnlyList[string]] = nil
    ) IReadOnlyCollection[string] {
        let referenced = HashSet[string](StringComparer.OrdinalIgnoreCase)
        for projectPath in projectPaths ?? Array.Empty[string]() {
            let items = Read(projectPath, "ProjectReference")
            for item in items {
                if string.IsNullOrEmpty(item.SourceInclude) {
                    continue
                }
                let referenceOutputAssembly = item
                    .Element
                    .Attribute(XName?("ReferenceOutputAssembly")!!)
                    ?.Value ??
                    item
                    .Element
                    .Elements()
                    .FirstOrDefault(
                    (e XElement) -> e
                        .Name
                        .LocalName
                        .Equals("ReferenceOutputAssembly", StringComparison.OrdinalIgnoreCase)
                )
                    ?.Value
                if string.Equals(referenceOutputAssembly?.Trim(), "false", StringComparison.OrdinalIgnoreCase) {
                    continue
                }
                referenced.Add(item.SourceInclude!!)
            }
            var evaluatedPaths IReadOnlyList[string]? = nil
            evaluatedProjectReferences?.TryGetValue(Path.GetFullPath(projectPath), out evaluatedPaths)
            referenced.UnionWith(RequireEvaluatedProjectReferencePaths(projectPath, items, evaluatedPaths))
        }
        return referenced
    }

    /// Bumps a below-floor literal `Version` attribute on a declared
    /// `Nerdbank.GitVersioning` `PackageReference` item (issue #2319,
    /// following #2225/#2267). When the source project's own `.csproj`
    /// declares nbgv directly — rather than via an ancestor
    /// `Directory.Build.props`/`Directory.Packages.props` split, the
    /// shape (cref:TranslateStage.EmitNerdbankGitVersioningBumps)'s
    /// (cref:StageExecutionContext.BuildOnlyPackageReferences) path
    /// exists to recover — this same declared item is what
    /// `SdkCompileRunner.BuildProjectXml`'s declared-item passthrough
    /// re-emits <b>verbatim</b> into the generated `.gsproj`. Without this
    /// rewrite the below-floor version silently survives into the isolated
    /// build and nbgv never emits the G# `ThisAssembly` source. Every
    /// other declared `PackageReference` item (including nbgv items that
    /// are already at or above the floor, or carry a non-literal version this
    /// policy cannot safely reason about) is returned unchanged — this never
    /// touches ordinary package references, and a CPM project's own
    /// versionless nbgv `PackageReference` has no `Version` attribute
    /// to bump in the first place, so CPM behavior is unaffected.
    /// @param items The declared `PackageReference` items read from the source project.
    /// @returns [`items`](paramref) unchanged when no item needs bumping, otherwise
    /// an equivalent list with the nbgv item's `Version` attribute bumped.
    internal func BumpNerdbankGitVersioningVersion(items IReadOnlyList[DeclaredProjectItem]?) IReadOnlyList[
        DeclaredProjectItem
    ] {
        if items == nil || items.Count == 0 {
            return items ?? Array.Empty[DeclaredProjectItem]()
        }
        var rewritten List[DeclaredProjectItem]? = nil
        for var i = 0; i < items.Count; i++ {
            let item = items[i]
            let include = item.Element.Attribute(XName?("Include")!!)?.Value
            let version = item.Element.Attribute(XName?("Version")!!)?.Value
            let isNbgv = string.Equals(
                include,
                NerdbankGitVersioningPolicy.PackageId,
                StringComparison.OrdinalIgnoreCase
            )
            if !isNbgv || !NerdbankGitVersioningPolicy.TryGetRequiredBump(version, out var bumped) {
                rewritten?.Add(item)
                continue
            }
            // First bump found: materialize the prefix of untouched items so
            // the returned list mirrors the input verbatim up to this point.
            rewritten ??= List[DeclaredProjectItem](items.Take(i))
            let element = XElement(item.Element)
            element.SetAttributeValue(XName?("Version")!!, bumped)
            rewritten!!.Add(
                DeclaredProjectItem(item.ItemGroupCondition, element, item.SourceInclude, item.SourceAssemblyName)
            )
        }
        return rewritten ?? items
    }

    internal func RewriteProjectReferences(
        items IReadOnlyList[DeclaredProjectItem]?,
        generatedProjectDirectory string,
        generatedProjectPaths IReadOnlyDictionary[string, string]?
    ) IReadOnlyList[DeclaredProjectItem] {
        let rewritten = List[DeclaredProjectItem]()
        for item in items ?? Array.Empty[DeclaredProjectItem]() {
            let element = XElement(item.Element)
            let targetPath string? = item.SourceInclude
            let include string? = element.Attribute(XName?("Include")!!)?.Value
            if string.IsNullOrEmpty(targetPath) && IsMsbuildExpression(include) {
                continue
            }
            var path string? = targetPath as string
            if path != nil && path.Length > 0 {
                if generatedProjectPaths != nil && generatedProjectPaths.TryGetValue(
                    Path.GetFullPath(path),
                    out var generatedPath
                ) {
                    path = generatedPath
                }
                element.SetAttributeValue(XName?("Include")!!, Path.GetRelativePath(generatedProjectDirectory, path))
            }
            rewritten.Add(
                DeclaredProjectItem(item.ItemGroupCondition, element, item.SourceInclude, item.SourceAssemblyName)
            )
        }
        return rewritten
    }

    internal func HasMsbuildExpressionInclude(item DeclaredProjectItem?) bool -> item != nil &&
        IsMsbuildExpression(item.Element.Attribute(XName?("Include")!!)?.Value)

    private func RequireEvaluatedProjectReferencePaths(
        projectPath string,
        items IReadOnlyList[DeclaredProjectItem],
        evaluatedProjectReferencePaths IReadOnlyList[string]?
    ) IReadOnlyList[string] {
        let expressions = items
            .Where(HasMsbuildExpressionInclude)
            .Select((item DeclaredProjectItem) -> item.Element.Attribute(XName?("Include")!!)?.Value)
            .Where((include string) -> !string.IsNullOrEmpty(include))
            .OrderBy((include string) -> include, StringComparer.Ordinal)
            .ToArray()
        if expressions.Length == 0 {
            return Array.Empty[string]()
        }
        if evaluatedProjectReferencePaths != nil {
            return evaluatedProjectReferencePaths
        }
        throw InvalidOperationException(
            "Project '${Path.GetFullPath(projectPath)}' declares ProjectReference Include " +
                "expressions that require MSBuild evaluation: ${string.Join(", ", expressions.Select((expression string) -> "'$expression'"))}."
        )
    }

    private func IsMsbuildExpression(value string?) bool {
        if value is not string text {
            return false
        }
        return text.Contains("$$(", StringComparison.Ordinal) || text.Contains("@(", StringComparison.Ordinal)
    }

    private func StripNamespaces(element XElement) XElement -> XElement(
        XName?(element.Name.LocalName)!!,
        element
            .Attributes()
            .Where((attribute XAttribute) -> !attribute.IsNamespaceDeclaration)
            .Select((attribute XAttribute) -> XAttribute(XName?(attribute.Name.LocalName)!!, attribute.Value)),
        element.Nodes().Select(
            (node XNode) -> if node is XElement child {
                cast[XNode](StripNamespaces(child))
            } else {
                node
            }
        )
    )
}
