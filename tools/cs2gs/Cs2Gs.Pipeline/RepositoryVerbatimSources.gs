// <copyright file="RepositoryVerbatimSources.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Text
import System.Text.RegularExpressions
import System.Xml.Linq
import System.Xml

/// Issue #4850: the single decision point for which checked-in `.cs`
/// files a repository mirror carries VERBATIM instead of translating.
/// @remarks A `.cs` file is translated when a translated project compiles it, or,
/// failing that, as an orphan. That is wrong for a `.cs` file a project
/// references as DATA or as foreign input rather than as source it compiles:
/// a `None`/`Content`/`EmbeddedResource` item (translation-test
/// fixtures a test reads as text) or a `Compile` item of an already-G#
/// project (`ForeignCompile.gsproj` lists `ThisAssembly.cs` for the
/// SDK to translate at build time). Translating those silently rewrites the
/// data and leaves the project pointing at a file the mirror no longer has.
///
/// The rule: a `.cs` file matched by any item of a repository project file
/// other than a `Compile` item of a translated (`.csproj`, shared
/// `.props`/`.targets`) project is copied verbatim. A file that is
/// both (compiled by a translated project AND referenced as data) is
/// translated and ALSO copied. Item operations are applied in document order
/// per item type, as MSBuild does. Includes that cannot be resolved statically
/// (unknown MSBuild properties) and explicitly name `.cs` files are
/// reported as warnings rather than guessed at.
internal shared class RepositoryVerbatimSources {
    private data class ItemOperation(Remove bool, Matches[]Regex, Excludes[]Regex) : IEquatable[ItemOperation] { }

    private let ProjectExtensions[]string = []string{".csproj", ".gsproj", ".props", ".targets"}

    /// Computes the `.cs` inventory entries copied verbatim.
    /// @param sourceRoot The repository source root.
    /// @param inventory The repository inventory (root-relative paths).
    /// @param warnings Receives unresolvable-include warnings, or `null` to ignore them.
    /// @returns The matching inventory entries, spelled as in [`inventory`](paramref), case-insensitive.
    internal func Compute(
        sourceRoot string?,
        inventory IReadOnlyList[string]?,
        warnings ICollection[string]? = nil
    ) ISet[string] {
        let result = HashSet[string](StringComparer.OrdinalIgnoreCase)
        // Matching runs over '/'-separated paths; the result keeps the inventory's
        // own spelling, which is what callers use for set membership.
        let csharpFiles = List[(Normalized string, Original string)]()
        for path in inventory!! {
            if Path.GetExtension(path).Equals(".cs", StringComparison.OrdinalIgnoreCase) {
                csharpFiles.Add((path.Replace('\\', '/'), path))
            }
        }
        if csharpFiles.Count == 0 {
            return result
        }
        let root = Path.GetFullPath(sourceRoot!!)
        let documents = List[(Path string, Document XDocument)]()
        for projectPath in inventory!!.Where(
            (path string) -> ProjectExtensions.Contains(Path.GetExtension(path), StringComparer.OrdinalIgnoreCase)
        ) {
            try {
                documents.Add(
                    (
                        projectPath,
                        XDocument.Load(
                            Path.Combine(root, projectPath.Replace('\\', '/').Replace('/', Path.DirectorySeparatorChar))
                        )
                    )
                )
            } catch (ex Exception) when ex is XmlException || ex is IOException {
                continue
            }
        }
        // Shared .props/.targets: their items belong to whichever projects import
        // them, transitively, and their relative includes resolve against the
        // IMPORTING project's directory (an anchored include resolves beside the
        // file). The importer kind only decides what a Compile item means: a
        // translated project (.csproj) owns it, a .gsproj keeps foreign C# verbatim
        // (the SDK translates it at build time). A shared file nothing imports is
        // not evaluated. The import match is by file name, so it over-approximates;
        // over-copying a .cs is safe, dropping one is not.
        let sharedImports = Dictionary[string, HashSet[string]](StringComparer.OrdinalIgnoreCase)
        for (path, doc) in documents {
            if IsSharedFile(path) {
                let name = Path.GetFileName(path.Replace('\\', '/'))
                if !sharedImports.TryGetValue(name, out var names) {
                    sharedImports[name] = (names = HashSet[string](StringComparer.OrdinalIgnoreCase))
                }
                names.UnionWith(ImportedFileNames(doc))
            }
        }
        // MSBuild imports Directory.Build.props/.targets implicitly from every
        // ancestor directory; they seed a project's import closure like an
        // explicit Import, so what THEY import is reachable too.
        let implicitImports = documents
            .Where(
            (d(Path string, Document XDocument)) -> IsSharedFile(d.Path) && Path.GetFileName(d.Path.Replace('\\', '/'))
                .StartsWith("Directory.", StringComparison.OrdinalIgnoreCase)
        )
            .Select(
            (d(Path string, Document XDocument)) -> (
                Directory: DirectoryOf(d.Path.Replace('\\', '/')),
                Name: Path.GetFileName(d.Path.Replace('\\', '/'))
            )
        )
            .ToList()
        let importers = documents
            .Where((d(Path string, Document XDocument)) -> !IsSharedFile(d.Path))
            .Select(
            (d(Path string, Document XDocument)) -> {
                let projectDirectory = DirectoryOf(d.Path.Replace('\\', '/'))
                let seeds = ImportedFileNames(d.Document)
                seeds.UnionWith(
                    implicitImports.Where((i(Directory string, Name string)) -> IsAtOrAbove(i.Item1, projectDirectory))
                        .Select((i(Directory string, Name string)) -> i.Item2)
                )
                return (
                    Directory: projectDirectory,
                    IsGsharp: Path.GetExtension(d.Path).Equals(".gsproj", StringComparison.OrdinalIgnoreCase),
                    Imports: ImportClosure(seeds, sharedImports)
                )
            }
        )
            .ToList()
        for (projectPath, document) in documents {
            let directory = DirectoryOf(projectPath.Replace('\\', '/'))
            let fileName = Path.GetFileName(projectPath.Replace('\\', '/'))
            // Relative includes resolve against the importing project, an include
            // anchored with MSBuildThisFileDirectory against the file itself. A
            // Compile item only means "foreign C#" for G# importers.
            var allImporterDirectories = List[string]{directory}
            var gsharpDirectories = List[string]{directory}
            var translatedProject bool
            if IsSharedFile(projectPath) {
                let owners = importers.Where(
                    (i(Directory string, IsGsharp bool, Imports HashSet[string])) -> if fileName.StartsWith(
                        "Directory.",
                        StringComparison.OrdinalIgnoreCase
                    ) {
                        IsAtOrAbove(directory, i.Item1)
                    } else {
                        i.Item3.Contains(fileName)
                    }
                )
                    .ToList()
                if owners.Count == 0 {
                    continue
                }
                allImporterDirectories = owners
                    .Select((i(Directory string, IsGsharp bool, Imports HashSet[string])) -> i.Item1)
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .ToList()
                gsharpDirectories = owners
                    .Where((i(Directory string, IsGsharp bool, Imports HashSet[string])) -> i.Item2)
                    .Select((i(Directory string, IsGsharp bool, Imports HashSet[string])) -> i.Item1)
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .ToList()
                translatedProject = gsharpDirectories.Count == 0
            } else {
                translatedProject = !Path.GetExtension(projectPath).Equals(
                    ".gsproj",
                    StringComparison.OrdinalIgnoreCase
                )
            }
            // MSBuild evaluates item operations in document order per item
            // type, so a later Include can re-add what an earlier Remove took.
            let operations = Dictionary[string, List[ItemOperation]](StringComparer.OrdinalIgnoreCase)
            for item in document.Descendants().Where(
                (e XElement) -> e.Parent != nil &&
                    e.Parent!!
                    .Name
                    .LocalName
                    .Equals("ItemGroup", StringComparison.OrdinalIgnoreCase)
            ) {
                let itemName = item.Name.LocalName
                let isCompile = itemName.Equals("Compile", StringComparison.OrdinalIgnoreCase)
                let relativeDirectories IReadOnlyList[string] = if isCompile {
                    gsharpDirectories
                } else {
                    allImporterDirectories
                }
                let anchoredDirectories = []string{directory}
                if translatedProject && isCompile {
                    // Compiled by a translated project: the translation owns it.
                    continue
                }
                if !operations.TryGetValue(itemName, out var list) {
                    operations[itemName] = (list = List[ItemOperation]())
                }
                // A Remove under a condition, or inside a target, may never run;
                // letting it clear an established reference could drop a required
                // file, so it is ignored (over-copying a .cs is safe, dropping is not).
                let remove string? = item.Attribute(XName?("Remove")!!)?.Value
                if remove != nil && !IsConditionalOrDynamic(item) {
                    list.Add(
                        ItemOperation(
                            true,
                            Patterns(remove, relativeDirectories, anchoredDirectories, nil).ToArray(),
                            Array.Empty[Regex]()
                        )
                    )
                }
                // Update changes metadata of items already in the list; it never
                // adds one, so only Include can make a file referenced.
                let value string? = item.Attribute(XName?("Include")!!)?.Value
                if value == nil {
                    continue
                }
                let unresolved List[string]? = if warnings == nil {
                    default(List[string]?)
                } else {
                    List[string]()
                }
                list.Add(
                    ItemOperation(
                        false,
                        Patterns(value, relativeDirectories, anchoredDirectories, unresolved).ToArray(),
                        Patterns(
                            item.Attribute(XName?("Exclude")!!)?.Value,
                            relativeDirectories,
                            anchoredDirectories,
                            nil
                        ).ToArray()
                    )
                )
                if unresolved != nil {
                    for text in unresolved {
                        warnings!!.Add(
                            "'$projectPath' $itemName item '$text' uses an MSBuild expression this " +
                                "mirror cannot resolve; if it names .cs files they will be translated, not copied."
                        )
                    }
                }
            }
            for list in operations.Values {
                for (normalized, original) in csharpFiles {
                    var referenced = false
                    for operation in list {
                        if !operation.Matches.Any((r Regex) -> r.IsMatch(normalized)) {
                            continue
                        }
                        // Exclude only stops THIS Include from adding the file; an
                        // earlier item that already added it still stands.
                        if operation.Remove {
                            referenced = false
                        } else if !operation.Excludes.Any((r Regex) -> r.IsMatch(normalized)) {
                            referenced = true
                        }
                    }
                    if referenced {
                        result.Add(original)
                    }
                }
            }
        }
        return result
    }

    private func Patterns(
        itemValue string?,
        relativeDirectories IReadOnlyList[string],
        anchoredDirectories IReadOnlyList[string],
        unresolved ICollection[string]?
    ) sequence[Regex] {
        if string.IsNullOrWhiteSpace(itemValue) {
            yield break
        }
        for raw in itemValue.Split(';', StringSplitOptions.RemoveEmptyEntries) {
            // The two directory anchors resolve to the file's own directory,
            // which Resolve prepends once below; substituting the directory
            // here too would duplicate it.
            let anchoredToFile = raw.Contains("$$(MSBuildThisFileDirectory)", StringComparison.OrdinalIgnoreCase)
            let text = raw
                .Trim()
                .Replace("$$(MSBuildThisFileDirectory)", string.Empty, StringComparison.OrdinalIgnoreCase)
                .Replace("$$(MSBuildProjectDirectory)", string.Empty, StringComparison.OrdinalIgnoreCase)
                .Replace('\\', '/')
            if text.Contains("$$(", StringComparison.Ordinal) || text.Contains("@(", StringComparison.Ordinal) ||
                text
                .Contains("%(", StringComparison.Ordinal) {
                // Only worth a warning when the text explicitly names C# sources;
                // a bare `$(PublishDir)**\*` payload glob is build output.
                if unresolved != nil && text.EndsWith(".cs", StringComparison.OrdinalIgnoreCase) {
                    unresolved.Add(raw.Trim())
                }
                continue
            }
            for baseDirectory in if anchoredToFile {
                anchoredDirectories
            } else {
                relativeDirectories
            } {
                let resolved string? = Resolve(baseDirectory, text)
                if resolved != nil {
                    yield GlobToRegex(resolved)
                }
            }
        }
    }

    private func Resolve(projectDirectory string, path string) string? {
        let segments = List[string](projectDirectory.Split('/', StringSplitOptions.RemoveEmptyEntries))
        for segment in path.Split('/', StringSplitOptions.RemoveEmptyEntries) {
            if segment == "." {
                continue
            }
            if segment == ".." {
                if segments.Count == 0 {
                    return nil
                }
                segments.RemoveAt(segments.Count - 1)
                continue
            }
            segments.Add(segment)
        }
        return string.Join('/', segments)
    }

    private func GlobToRegex(glob string) Regex {
        let pattern = StringBuilder("^")
        for var i = 0; i < glob.Length; i++ {
            let c = glob[i]
            if c == '*' && i + 1 < glob.Length && glob[i + 1] == '*' {
                let followedBySlash = i + 2 < glob.Length && glob[i + 2] == '/'
                pattern.Append(
                    if followedBySlash {
                        "(?:.*/)?"
                    } else {
                        ".*"
                    }
                )
                i += if followedBySlash {
                    2
                } else {
                    1
                }
            } else if c == '*' {
                pattern.Append("[^/]*")
            } else if c == '?' {
                pattern.Append("[^/]")
            } else {
                pattern.Append(Regex.Escape(c.ToString()))
            }
        }
        pattern.Append('$')
        return Regex(pattern.ToString(), RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)
    }

    private func IsAtOrAbove(ancestor string, directory string) bool -> ancestor.Length == 0 || directory.Equals(
        ancestor,
        StringComparison.OrdinalIgnoreCase
    ) ||
        directory.StartsWith(ancestor + "/", StringComparison.OrdinalIgnoreCase)

    private func IsSharedFile(path string) bool {
        let extension = Path.GetExtension(path)
        return extension.Equals(".props", StringComparison.OrdinalIgnoreCase) || extension.Equals(
            ".targets",
            StringComparison.OrdinalIgnoreCase
        )
    }

    private func ImportedFileNames(document XDocument) HashSet[string] {
        let names = HashSet[string](StringComparer.OrdinalIgnoreCase)
        for import_ in document.Descendants().Where(
            (e XElement) -> e.Name.LocalName.Equals("Import", StringComparison.OrdinalIgnoreCase)
        ) {
            let project string? = import_.Attribute(XName?("Project")!!)?.Value
            if !string.IsNullOrWhiteSpace(project) {
                names.Add(project.Replace('\\', '/').Split('/').Last().Trim())
            }
        }
        return names
    }

    private func ImportClosure(direct HashSet[string], sharedImports Dictionary[string, HashSet[string]]) HashSet[
        string
    ] {
        let closure = HashSet[string](direct, StringComparer.OrdinalIgnoreCase)
        let pending = Queue[string](direct)
        while pending.Count > 0 {
            if sharedImports.TryGetValue(pending.Dequeue(), out var next) {
                for name in next.Where(closure.Add) {
                    pending.Enqueue(name)
                }
            }
        }
        return closure
    }

    private func IsConditionalOrDynamic(item XElement) bool -> item.AncestorsAndSelf().Any(
        (e XElement) -> e.Attribute(XName?("Condition")!!) != nil ||
            e
            .Name
            .LocalName
            .Equals("Target", StringComparison.OrdinalIgnoreCase)
    )

    private func DirectoryOf(relativePath string) string {
        let separator = relativePath.LastIndexOf('/')
        return if separator < 0 {
            string.Empty
        } else {
            relativePath.Substring(0, separator)
        }
    }
}
