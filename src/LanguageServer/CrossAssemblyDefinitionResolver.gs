// <copyright file="CrossAssemblyDefinitionResolver.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.LanguageServer.Protocol
import Range = GSharp.LanguageServer.Protocol.Range
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Text.RegularExpressions

/// Resolves imported CLR (cref:Type)s and (cref:MemberInfo)s to
/// source (cref:Location)s. Implements two tiers of cross-project
/// Go-to-Definition for the language server:
/// 1. <b>Tier 1 — Sibling G# project source walk.</b> When the supplied member belongs to an assembly
/// produced by another `.gsproj` in the workspace, look the matching declaration up in that project's
/// (cref:Compilation) and return the in-source identifier token. This path is preferred because it does
/// not require a portable PDB to exist on disk: a freshly-restored (but not yet built) sibling project
/// still resolves.
/// 2. <b>Tier 2 — Portable-PDB navigation.</b> For everything else (C# / F# / VB siblings, NuGet
/// packages with embedded or sidecar PDBs, or G# siblings whose Tier 1 lookup did not match) delegate
/// to (cref:PdbSourceLocator), which reads sequence points to recover the original source file and
/// line.
internal shared class CrossAssemblyDefinitionResolver {
    /// Resolves an imported CLR (cref:Type) (class, struct, enum,
    /// interface, delegate) to its source location.
    /// @param workspace The owning workspace; may be `null` in scenarios
    /// without project discovery, in which case only Tier 2 is attempted.
    /// @param type The CLR type to navigate to.
    /// @param location The resolved source location on success.
    /// @returns True when a location was resolved.
    func TryResolveType(workspace WorkspaceState?, type Type?, out location Location?) bool {
        location = nil
        if type == nil {
            return false
        }
        let assemblyPath string? = TryGetAssemblyPath(type.Assembly)
        if assemblyPath == nil {
            return false
        }
        if workspace != nil && workspace.TryGetProjectByOutputAssembly(assemblyPath, out var siblingProject) &&
            TryResolveTypeInSiblingProject(siblingProject!!, type, out location) {
            return true
        }
        // Tier 3 — source-text search. Preferred over the PDB for workspace-local assemblies
        // because it lands on the actual type-declaration identifier; the PDB only knows method
        // sequence points, so it lands on the first executable line (e.g. inside a constructor)
        // and can't locate types with no method bodies (interfaces). Only does real work for
        // assemblies built from a project under the workspace; everything else falls through.
        if TryResolveTypeBySourceSearch(assemblyPath, type, out location) {
            return true
        }
        if PdbSourceLocator.TryGetTypeSourceLocation(assemblyPath, type.MetadataToken, out var pdbLocation) {
            location = ToLocation(pdbLocation)
            return true
        }
        return false
    }

    /// Resolves an imported CLR (cref:MethodInfo) to its source location.
    /// @param workspace The owning workspace.
    /// @param method The CLR method to navigate to.
    /// @param location The resolved source location on success.
    /// @returns True when a location was resolved.
    func TryResolveMethod(workspace WorkspaceState?, method MethodInfo?, out location Location?) bool {
        location = nil
        if method == nil {
            return false
        }
        let declaringType Type? = method.DeclaringType
        let assemblyPath string? = TryGetAssemblyPath(declaringType?.Assembly ?? method.Module?.Assembly)
        if assemblyPath == nil {
            return false
        }
        if workspace != nil && declaringType != nil && workspace.TryGetProjectByOutputAssembly(
            assemblyPath,
            out var siblingProject
        ) &&
            TryResolveMethodInSiblingProject(siblingProject!!, declaringType, method, out location) {
            return true
        }
        // Tier 3 — source-text search (preferred over the PDB for workspace-local assemblies; the
        // PDB token from a stripped ref-assembly often doesn't match the runtime PDB).
        if TryResolveMemberBySourceSearch(assemblyPath, declaringType, method.Name, out location) {
            return true
        }
        if PdbSourceLocator.TryGetMethodSourceLocation(assemblyPath, method.MetadataToken, out var pdbLocation) {
            location = ToLocation(pdbLocation)
            return true
        }
        // Fall back to the declaring type's source line — at least gets the user into the right file.
        return declaringType != nil && TryResolveType(workspace, declaringType, out location)
    }

    /// Resolves an imported CLR (cref:PropertyInfo) to its source
    /// location. Tries Tier 1 against the sibling project's
    /// (cref:PropertySymbol) declaration, then falls back to PDB lookup
    /// of the property's getter (or setter for write-only properties).
    /// @param workspace The owning workspace.
    /// @param property The CLR property to navigate to.
    /// @param location The resolved source location on success.
    /// @returns True when a location was resolved.
    func TryResolveProperty(workspace WorkspaceState?, property PropertyInfo?, out location Location?) bool {
        location = nil
        if property == nil {
            return false
        }
        let declaringType Type? = property.DeclaringType
        let assemblyPath string? = TryGetAssemblyPath(declaringType?.Assembly)
        if assemblyPath == nil {
            return false
        }
        if workspace != nil && declaringType != nil && workspace.TryGetProjectByOutputAssembly(
            assemblyPath,
            out var siblingProject
        ) &&
            TryResolvePropertyInSiblingProject(siblingProject!!, declaringType, property.Name, out location) {
            return true
        }
        if TryResolveMemberBySourceSearch(assemblyPath, declaringType, property.Name, out location) {
            return true
        }
        let accessor MethodInfo? = property.GetGetMethod(nonPublic: true) ?? property.GetSetMethod(nonPublic: true)
        if accessor != nil && PdbSourceLocator.TryGetMethodSourceLocation(
            assemblyPath,
            accessor.MetadataToken,
            out var pdbLocation
        ) {
            location = ToLocation(pdbLocation)
            return true
        }
        return declaringType != nil && TryResolveType(workspace, declaringType, out location)
    }

    /// Resolves an imported CLR (cref:FieldInfo) to its source location.
    /// Portable PDBs do not record field-level sequence points, so Tier 2
    /// falls back to the declaring type's source location.
    /// @param workspace The owning workspace.
    /// @param field The CLR field to navigate to.
    /// @param location The resolved source location on success.
    /// @returns True when a location was resolved.
    func TryResolveField(workspace WorkspaceState?, field FieldInfo?, out location Location?) bool {
        location = nil
        if field == nil {
            return false
        }
        let declaringType Type? = field.DeclaringType
        let assemblyPath string? = TryGetAssemblyPath(declaringType?.Assembly)
        if assemblyPath == nil {
            return false
        }
        if workspace != nil && declaringType != nil && workspace.TryGetProjectByOutputAssembly(
            assemblyPath,
            out var siblingProject
        ) &&
            TryResolveFieldInSiblingProject(siblingProject!!, declaringType, field.Name, out location) {
            return true
        }
        if TryResolveMemberBySourceSearch(assemblyPath, declaringType, field.Name, out location) {
            return true
        }
        return declaringType != nil && TryResolveType(workspace, declaringType, out location)
    }

    /// Resolves an imported CLR (cref:EventInfo) to its source location.
    /// @param workspace The owning workspace.
    /// @param evt The CLR event to navigate to.
    /// @param location The resolved source location on success.
    /// @returns True when a location was resolved.
    func TryResolveEvent(workspace WorkspaceState?, evt EventInfo?, out location Location?) bool {
        location = nil
        if evt == nil {
            return false
        }
        let declaringType Type? = evt.DeclaringType
        let assemblyPath string? = TryGetAssemblyPath(declaringType?.Assembly)
        if assemblyPath == nil {
            return false
        }
        if workspace != nil && declaringType != nil && workspace.TryGetProjectByOutputAssembly(
            assemblyPath,
            out var siblingProject
        ) &&
            TryResolveEventInSiblingProject(siblingProject!!, declaringType, evt.Name, out location) {
            return true
        }
        if TryResolveMemberBySourceSearch(assemblyPath, declaringType, evt.Name, out location) {
            return true
        }
        let accessor MethodInfo? = evt.GetAddMethod(nonPublic: true) ?? evt.GetRemoveMethod(nonPublic: true)
        if accessor != nil && PdbSourceLocator.TryGetMethodSourceLocation(
            assemblyPath,
            accessor.MetadataToken,
            out var pdbLocation
        ) {
            location = ToLocation(pdbLocation)
            return true
        }
        return declaringType != nil && TryResolveType(workspace, declaringType, out location)
    }

    internal func TryResolveTypeBySourceSearch(assemblyPath string, type Type, out location Location?) bool {
        location = nil
        let projectDirectory string? = DeriveProjectDirectory(assemblyPath)
        if projectDirectory == nil || !Directory.Exists(projectDirectory) {
            return false
        }
        var simpleName = type.Name
        let backtick = simpleName.IndexOf('`')
        if backtick > 0 {
            simpleName = simpleName.Substring(0, backtick)
        }
        if string.IsNullOrEmpty(simpleName) {
            return false
        }
        // Match a C#/G# type declaration: a type keyword, optional modifiers/`record struct`,
        // then the simple name as a whole word, all before any `{`, `:`, `(`, or end of line.
        let pattern = "\\b(?:interface|class|struct|enum|record)\\b[^\\r\\n{:(]*?\\b" + Regex.Escape(simpleName) + "\\b"
        let regex = Regex(pattern)
        for sourceFile in EnumerateProjectSources(projectDirectory) {
            var text string
            try {
                text = File.ReadAllText(sourceFile)
            } catch (IOException) {
                continue
            }
            let match = regex.Match(text)
            if !match.Success {
                continue
            }
            // Point at the type name itself, not the leading keyword.
            var nameIndex = text.IndexOf(simpleName, match.Index, StringComparison.Ordinal)
            if nameIndex < 0 {
                nameIndex = match.Index
            }
            let (line, character) = OffsetToLineColumn(text, nameIndex)
            location = Location{
                Uri: DocumentUri.FromFileSystemPath(sourceFile),
                Range: Range(Position(line, character), Position(line, character + simpleName.Length))
            }
            return true
        }
        return false
    }

    // Tier-3 member navigation: scans the declaring type's source file(s) (under the workspace)
    // for a member declaration of memberName. Distinguishes a declaration from a call/usage by
    // requiring the member name to be preceded, on the same line, by a return/field type (and
    // optional modifiers) and followed by `(`, `{`, `=`, or `;`. Best-effort: returns the first
    // plausible declaration found.
    internal func TryResolveMemberBySourceSearch(
        assemblyPath string,
        declaringType Type?,
        memberName string,
        out location Location?
    ) bool {
        location = nil
        if declaringType == nil || string.IsNullOrEmpty(memberName) {
            return false
        }
        let projectDirectory string? = DeriveProjectDirectory(assemblyPath)
        if projectDirectory == nil || !Directory.Exists(projectDirectory) {
            return false
        }
        var typeName = declaringType.Name
        let backtick = typeName.IndexOf('`')
        if backtick > 0 {
            typeName = typeName.Substring(0, backtick)
        }
        let typeRegex = Regex(
            "\\b(?:interface|class|struct|enum|record)\\b[^\\r\\n{:(]*?\\b" + Regex.Escape(typeName) + "\\b"
        )
        // A member declaration line: leading indentation, optional attributes, optional modifiers,
        // a return/field type token, then the member name, then `(` (method), `<` (generic method),
        // `{` (property), `=` (expression body / field init), or `;` (field / abstract member).
        let memberRegex = Regex(
            "(?m)^[ \\t]*(?:\\[[^\\]]*\\][ \\t]*)*(?:[\\w.<>\\[\\],?]+[ \\t]+)+" + Regex.Escape(memberName) +
                "[ \\t]*(?:<[^>]*>)?[ \\t]*[({=;]"
        )
        for sourceFile in EnumerateProjectSources(projectDirectory) {
            var text string
            try {
                text = File.ReadAllText(sourceFile)
            } catch (IOException) {
                continue
            }
            // Only search files that declare the owning type (handles partial types across files
            // and avoids matching a same-named member on an unrelated type).
            if !typeRegex.IsMatch(text) {
                continue
            }
            let match = memberRegex.Match(text)
            if !match.Success {
                continue
            }
            var nameIndex = text.IndexOf(memberName, match.Index, StringComparison.Ordinal)
            if nameIndex < 0 {
                nameIndex = match.Index
            }
            let (line, character) = OffsetToLineColumn(text, nameIndex)
            location = Location{
                Uri: DocumentUri.FromFileSystemPath(sourceFile),
                Range: Range(Position(line, character), Position(line, character + memberName.Length))
            }
            return true
        }
        return false
    }

    /// Derives the owning project directory from a built assembly path by trimming everything
    /// at and below the MSBuild `obj` (or `bin`) output folder, e.g.
    /// `/repo/src/Lib/obj/Debug/net10.0/ref/Lib.dll` → `/repo/src/Lib`.
    private func DeriveProjectDirectory(assemblyPath string) string? {
        var directory = Path.GetDirectoryName(assemblyPath)
        while !string.IsNullOrEmpty(directory) {
            let leaf = Path.GetFileName(directory)
            let parent = Path.GetDirectoryName(directory)
            if string.Equals(leaf, "obj", StringComparison.OrdinalIgnoreCase) || string.Equals(
                leaf,
                "bin",
                StringComparison.OrdinalIgnoreCase
            ) {
                return parent
            }
            directory = parent
        }
        return nil
    }

    private func EnumerateProjectSources(projectDirectory string) sequence[string] {
        var files IEnumerable[string]
        try {
            files = Directory.EnumerateFiles(projectDirectory, "*.cs", SearchOption.AllDirectories).Concat(
                Directory.EnumerateFiles(projectDirectory, "*.gs", SearchOption.AllDirectories)
            )
        } catch (IOException) {
            yield break
        } catch (UnauthorizedAccessException) {
            yield break
        }
        for file in files {
            // Skip generated output so a copy in obj/ doesn't shadow the real source.
            if file.Contains(
                "${Path.DirectorySeparatorChar}obj${Path.DirectorySeparatorChar}",
                StringComparison.OrdinalIgnoreCase
            ) ||
                file
                .Contains(
                "${Path.DirectorySeparatorChar}bin${Path.DirectorySeparatorChar}",
                StringComparison.OrdinalIgnoreCase
            ) {
                continue
            }
            yield file
        }
    }

    private func OffsetToLineColumn(text string, offset int32)(Line int32, Character int32) {
        var line = 0
        var lineStart = 0
        for var i = 0; i < offset && i < text.Length; i++ {
            if text[i] == '\n' {
                line++
                lineStart = i + 1
            }
        }
        return (line, offset - lineStart)
    }

    private func TryResolveTypeInSiblingProject(siblingProject ProjectState, type Type, out location Location?) bool {
        location = nil
        let compilation Compilation? = siblingProject?.GetCompilation()
        if compilation == nil {
            return false
        }
        if TryFindStructSymbol(compilation, type, out var structSymbol) &&
            structSymbol != nil &&
            structSymbol.Declaration != nil {
            location = ToLocation(structSymbol.Declaration!!.Identifier)
            return location != nil
        }
        if TryFindEnumSymbol(compilation, type, out var enumSymbol) &&
            enumSymbol != nil &&
            enumSymbol.Declaration != nil {
            location = ToLocation(enumSymbol.Declaration.Identifier)
            return location != nil
        }
        if TryFindInterfaceSymbol(compilation, type, out var interfaceSymbol) &&
            interfaceSymbol != nil &&
            interfaceSymbol.Declaration != nil {
            location = ToLocation(interfaceSymbol.Declaration.Identifier)
            return location != nil
        }
        if TryFindDelegateSymbol(compilation, type, out var delegateDeclaration) && delegateDeclaration != nil {
            location = ToLocation(delegateDeclaration.Identifier)
            return location != nil
        }
        return false
    }

    private func TryResolveMethodInSiblingProject(
        siblingProject ProjectState,
        declaringType Type,
        method MethodInfo,
        out location Location?
    ) bool {
        location = nil
        let compilation Compilation? = siblingProject?.GetCompilation()
        if compilation == nil {
            return false
        }
        if TryFindStructSymbol(compilation, declaringType, out var structSymbol) && structSymbol != nil {
            let candidates = structSymbol
                .Methods
                .Concat(structSymbol.StaticMethods)
                .Where(
                (fs FunctionSymbol) -> fs.Declaration != nil && string.Equals(
                    fs.Name,
                    method.Name,
                    StringComparison.Ordinal
                )
            )
                .ToArray()
            let best = SelectMatchingMethod(candidates, method) ?? candidates.FirstOrDefault()
            if best?.Declaration != nil {
                location = ToLocation(best!!.Declaration!!.Identifier)
                return location != nil
            }
        }
        if TryFindInterfaceSymbol(compilation, declaringType, out var interfaceSymbol) && interfaceSymbol != nil {
            let match = interfaceSymbol.Methods.FirstOrDefault(
                (fs FunctionSymbol) -> fs.Declaration != nil && string.Equals(
                    fs.Name,
                    method.Name,
                    StringComparison.Ordinal
                )
            )
            if match?.Declaration != nil {
                location = ToLocation(match!!.Declaration!!.Identifier)
                return location != nil
            }
        }
        return false
    }

    private func TryResolvePropertyInSiblingProject(
        siblingProject ProjectState,
        declaringType Type,
        propertyName string,
        out location Location?
    ) bool {
        location = nil
        let compilation Compilation? = siblingProject?.GetCompilation()
        if compilation == nil ||
            !TryFindStructSymbol(compilation, declaringType, out var structSymbol) ||
            structSymbol == nil {
            return false
        }
        let property = structSymbol
            .Properties
            .Concat(structSymbol.StaticProperties)
            .FirstOrDefault(
            (p PropertySymbol) -> p.Declaration != nil && string.Equals(p.Name, propertyName, StringComparison.Ordinal)
        )
        if property?.Declaration != nil {
            location = ToLocation(property!!.Declaration!!.Identifier)
            return location != nil
        }
        return false
    }

    private func TryResolveFieldInSiblingProject(
        siblingProject ProjectState,
        declaringType Type,
        fieldName string,
        out location Location?
    ) bool {
        location = nil
        let compilation Compilation? = siblingProject?.GetCompilation()
        if compilation == nil ||
            !TryFindStructSymbol(compilation, declaringType, out var structSymbol) ||
            structSymbol == nil ||
            structSymbol.Declaration == nil {
            return false
        }
        for field in structSymbol.Declaration!!.Fields {
            if string.Equals(field.Identifier.Text, fieldName, StringComparison.Ordinal) {
                location = ToLocation(field.Identifier)
                return location != nil
            }
        }
        return false
    }

    private func TryResolveEventInSiblingProject(
        siblingProject ProjectState,
        declaringType Type,
        eventName string,
        out location Location?
    ) bool {
        location = nil
        let compilation Compilation? = siblingProject?.GetCompilation()
        if compilation == nil ||
            !TryFindStructSymbol(compilation, declaringType, out var structSymbol) ||
            structSymbol == nil {
            return false
        }
        let match = structSymbol
            .Events
            .Concat(structSymbol.StaticEvents)
            .FirstOrDefault(
            (e EventSymbol) -> e.Declaration != nil && string.Equals(e.Name, eventName, StringComparison.Ordinal)
        )
        if match?.Declaration != nil {
            location = ToLocation(match!!.Declaration!!.Identifier)
            return location != nil
        }
        return false
    }

    /// When several G# methods match a CLR method by name (overloads), pick the
    /// one whose parameter arity equals the CLR method's. Best-effort; the
    /// caller will fall back to the first match when nothing better is found.
    private func SelectMatchingMethod(candidates[]FunctionSymbol, method MethodInfo) FunctionSymbol? {
        if candidates.Length <= 1 {
            return candidates.FirstOrDefault()
        }
        let parameterCount = method.GetParameters().Length
        let arityMatch FunctionSymbol? = candidates.FirstOrDefault(
            (c FunctionSymbol) -> c.Parameters.Length == parameterCount
        )
        return arityMatch ?? candidates.FirstOrDefault()
    }

    private func TryFindStructSymbol(compilation Compilation?, type Type?, out structSymbol StructSymbol?) bool {
        structSymbol = nil
        if FindDeclaredType(compilation, type) is StructSymbol found {
            structSymbol = found
            return true
        }
        return false
    }

    private func TryFindEnumSymbol(compilation Compilation?, type Type?, out enumSymbol EnumSymbol?) bool {
        enumSymbol = nil
        if FindDeclaredType(compilation, type) is EnumSymbol found {
            enumSymbol = found
            return true
        }
        return false
    }

    private func TryFindInterfaceSymbol(
        compilation Compilation?,
        type Type?,
        out interfaceSymbol InterfaceSymbol?
    ) bool {
        interfaceSymbol = nil
        if FindDeclaredType(compilation, type) is InterfaceSymbol found {
            interfaceSymbol = found
            return true
        }
        return false
    }

    private func TryFindDelegateSymbol(
        compilation Compilation?,
        type Type?,
        out declaration DelegateDeclarationSyntax?
    ) bool {
        declaration = nil
        // Reuse never re-points a delegate's declaration, so read the current trees for the syntax.
        if FindDeclaredType(compilation, type) is DelegateTypeSymbol found {
            declaration = FindCurrentDelegateDeclaration(compilation!!, found.Declaration) ?? found.Declaration
            return declaration != nil
        }
        return false
    }

    // A body-only edit keeps every declaration in place, so the declaration at the same position among
    // the delegates of the same file is the current form of the one the symbol holds. This keeps the
    // identity of the selected delegate, including its package and arity.
    private func FindCurrentDelegateDeclaration(
        compilation Compilation,
        original DelegateDeclarationSyntax?
    ) DelegateDeclarationSyntax? {
        if original == nil || original.SyntaxTree == nil {
            return nil
        }
        let originalTree = original.SyntaxTree
        let originals = List[DelegateDeclarationSyntax]()
        CollectDelegateDeclarations(originalTree.Root, originals)
        let index = originals.IndexOf(original)
        if index < 0 {
            return nil
        }
        let fileName = originalTree.Text?.FileName
        for tree in compilation.SyntaxTrees {
            if object.ReferenceEquals(tree, originalTree) || ServerPathIdentity.AreSame(tree.Text?.FileName, fileName) {
                let currents = List[DelegateDeclarationSyntax]()
                CollectDelegateDeclarations(tree.Root, currents)
                return if index < currents.Count {
                    currents[index]
                } else {
                    default(DelegateDeclarationSyntax?)
                }
            }
        }
        return nil
    }

    private func CollectDelegateDeclarations(root SyntaxNode, into List[DelegateDeclarationSyntax]) {
        if root is DelegateDeclarationSyntax declaration {
            into.Add(declaration)
        }
        for child in root.GetChildren() {
            CollectDelegateDeclarations(child, into)
        }
    }

    /// Asks the sibling compilation for the type it declares under the CLR type's metadata name
    /// (ADR-0212 §7a): package, dot, name with generic arity, and `+` for each nesting level.
    private func FindDeclaredType(compilation Compilation?, type Type?) TypeSymbol? {
        if compilation == nil || type == nil {
            return nil
        }
        let definition = if type.IsGenericType && !type.IsGenericTypeDefinition {
            type.GetGenericTypeDefinition()
        } else {
            type
        }
        let metadataName = definition.FullName
        if string.IsNullOrEmpty(metadataName) {
            return nil
        }
        return compilation.GetTypeByMetadataName(metadataName)
    }

    private func ToLocation(token SyntaxToken?) Location? {
        if token == nil || token.IsMissing {
            return nil
        }
        let filePath = token.SyntaxTree?.Text?.FileName
        if string.IsNullOrEmpty(filePath) {
            return nil
        }
        return Location{Uri: DocumentUri.FromFileSystemPath(filePath), Range: SemanticLookup.ToRange(token)}
    }

    private func ToLocation(source PdbSourceLocator.SourceLocation) Location? {
        if string.IsNullOrEmpty(source.FilePath) {
            return nil
        }
        // PDB sequence points are 1-based; LSP positions are 0-based.
        let startLine = Math.Max(0, source.StartLine - 1)
        let startCol = Math.Max(0, source.StartColumn - 1)
        let endLine = Math.Max(0, source.EndLine - 1)
        let endCol = Math.Max(0, source.EndColumn - 1)
        return Location{
            Uri: DocumentUri.FromFileSystemPath(source.FilePath),
            Range: Range(Position(startLine, startCol), Position(endLine, endCol))
        }
    }

    private func TryGetAssemblyPath(assembly Assembly?) string? {
        if assembly == nil {
            return nil
        }
        // Delegates to ReferenceResolver.TryGetAssemblyPath which falls back
        // to the per-process registry of original paths for assemblies loaded
        // via MetadataLoadContext.LoadFromByteArray (whose Assembly.Location
        // is the empty string). See #853 / #858.
        return if ReferenceResolver.TryGetAssemblyPath(assembly, out var path) {
            path
        } else {
            default(string?)
        }
    }
}
