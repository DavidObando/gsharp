// <copyright file="CrossAssemblyDefinitionResolver.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.LanguageServer.Protocol;
using Range = GSharp.LanguageServer.Protocol.Range;

namespace GSharp.LanguageServer;

/// <summary>
/// Resolves imported CLR <see cref="Type"/>s and <see cref="MemberInfo"/>s to
/// source <see cref="Location"/>s. Implements two tiers of cross-project
/// Go-to-Definition for the language server:
/// <list type="number">
/// <item><b>Tier 1 — Sibling G# project source walk.</b> When the supplied
/// member belongs to an assembly produced by another <c>.gsproj</c> in the
/// workspace, look the matching declaration up in that project's
/// <see cref="Compilation"/> and return the in-source identifier token. This
/// path is preferred because it does not require a portable PDB to exist on
/// disk: a freshly-restored (but not yet built) sibling project still
/// resolves.</item>
/// <item><b>Tier 2 — Portable-PDB navigation.</b> For everything else (C# /
/// F# / VB siblings, NuGet packages with embedded or sidecar PDBs, or G#
/// siblings whose Tier 1 lookup did not match) delegate to
/// <see cref="PdbSourceLocator"/>, which reads sequence points to recover the
/// original source file and line.</item>
/// </list>
/// </summary>
internal static class CrossAssemblyDefinitionResolver
{
    /// <summary>
    /// Resolves an imported CLR <see cref="Type"/> (class, struct, enum,
    /// interface, delegate) to its source location.
    /// </summary>
    /// <param name="workspace">The owning workspace; may be <see langword="null"/> in scenarios
    /// without project discovery, in which case only Tier 2 is attempted.</param>
    /// <param name="type">The CLR type to navigate to.</param>
    /// <param name="location">The resolved source location on success.</param>
    /// <returns>True when a location was resolved.</returns>
    public static bool TryResolveType(WorkspaceState workspace, Type type, out Location location)
    {
        location = null;
        if (type == null)
        {
            return false;
        }

        var assemblyPath = TryGetAssemblyPath(type.Assembly);
        if (assemblyPath == null)
        {
            return false;
        }

        if (workspace != null
            && workspace.TryGetProjectByOutputAssembly(assemblyPath, out var siblingProject)
            && TryResolveTypeInSiblingProject(siblingProject, type, out location))
        {
            return true;
        }

        if (PdbSourceLocator.TryGetTypeSourceLocation(assemblyPath, type.MetadataToken, out var pdbLocation))
        {
            location = ToLocation(pdbLocation);
            return true;
        }

        return false;
    }

    /// <summary>
    /// Resolves an imported CLR <see cref="MethodInfo"/> to its source location.
    /// </summary>
    /// <param name="workspace">The owning workspace.</param>
    /// <param name="method">The CLR method to navigate to.</param>
    /// <param name="location">The resolved source location on success.</param>
    /// <returns>True when a location was resolved.</returns>
    public static bool TryResolveMethod(WorkspaceState workspace, MethodInfo method, out Location location)
    {
        location = null;
        if (method == null)
        {
            return false;
        }

        var declaringType = method.DeclaringType;
        var assemblyPath = TryGetAssemblyPath(declaringType?.Assembly ?? method.Module?.Assembly);
        if (assemblyPath == null)
        {
            return false;
        }

        if (workspace != null
            && declaringType != null
            && workspace.TryGetProjectByOutputAssembly(assemblyPath, out var siblingProject)
            && TryResolveMethodInSiblingProject(siblingProject, declaringType, method, out location))
        {
            return true;
        }

        if (PdbSourceLocator.TryGetMethodSourceLocation(assemblyPath, method.MetadataToken, out var pdbLocation))
        {
            location = ToLocation(pdbLocation);
            return true;
        }

        // Fall back to the declaring type's source line — at least gets the user into the right file.
        return declaringType != null && TryResolveType(workspace, declaringType, out location);
    }

    /// <summary>
    /// Resolves an imported CLR <see cref="PropertyInfo"/> to its source
    /// location. Tries Tier 1 against the sibling project's
    /// <see cref="PropertySymbol"/> declaration, then falls back to PDB lookup
    /// of the property's getter (or setter for write-only properties).
    /// </summary>
    /// <param name="workspace">The owning workspace.</param>
    /// <param name="property">The CLR property to navigate to.</param>
    /// <param name="location">The resolved source location on success.</param>
    /// <returns>True when a location was resolved.</returns>
    public static bool TryResolveProperty(WorkspaceState workspace, PropertyInfo property, out Location location)
    {
        location = null;
        if (property == null)
        {
            return false;
        }

        var declaringType = property.DeclaringType;
        var assemblyPath = TryGetAssemblyPath(declaringType?.Assembly);
        if (assemblyPath == null)
        {
            return false;
        }

        if (workspace != null
            && declaringType != null
            && workspace.TryGetProjectByOutputAssembly(assemblyPath, out var siblingProject)
            && TryResolvePropertyInSiblingProject(siblingProject, declaringType, property.Name, out location))
        {
            return true;
        }

        var accessor = property.GetGetMethod(nonPublic: true) ?? property.GetSetMethod(nonPublic: true);
        if (accessor != null && PdbSourceLocator.TryGetMethodSourceLocation(assemblyPath, accessor.MetadataToken, out var pdbLocation))
        {
            location = ToLocation(pdbLocation);
            return true;
        }

        return declaringType != null && TryResolveType(workspace, declaringType, out location);
    }

    /// <summary>
    /// Resolves an imported CLR <see cref="FieldInfo"/> to its source location.
    /// Portable PDBs do not record field-level sequence points, so Tier 2
    /// falls back to the declaring type's source location.
    /// </summary>
    /// <param name="workspace">The owning workspace.</param>
    /// <param name="field">The CLR field to navigate to.</param>
    /// <param name="location">The resolved source location on success.</param>
    /// <returns>True when a location was resolved.</returns>
    public static bool TryResolveField(WorkspaceState workspace, FieldInfo field, out Location location)
    {
        location = null;
        if (field == null)
        {
            return false;
        }

        var declaringType = field.DeclaringType;
        var assemblyPath = TryGetAssemblyPath(declaringType?.Assembly);
        if (assemblyPath == null)
        {
            return false;
        }

        if (workspace != null
            && declaringType != null
            && workspace.TryGetProjectByOutputAssembly(assemblyPath, out var siblingProject)
            && TryResolveFieldInSiblingProject(siblingProject, declaringType, field.Name, out location))
        {
            return true;
        }

        return declaringType != null && TryResolveType(workspace, declaringType, out location);
    }

    /// <summary>
    /// Resolves an imported CLR <see cref="EventInfo"/> to its source location.
    /// </summary>
    /// <param name="workspace">The owning workspace.</param>
    /// <param name="evt">The CLR event to navigate to.</param>
    /// <param name="location">The resolved source location on success.</param>
    /// <returns>True when a location was resolved.</returns>
    public static bool TryResolveEvent(WorkspaceState workspace, EventInfo evt, out Location location)
    {
        location = null;
        if (evt == null)
        {
            return false;
        }

        var declaringType = evt.DeclaringType;
        var assemblyPath = TryGetAssemblyPath(declaringType?.Assembly);
        if (assemblyPath == null)
        {
            return false;
        }

        if (workspace != null
            && declaringType != null
            && workspace.TryGetProjectByOutputAssembly(assemblyPath, out var siblingProject)
            && TryResolveEventInSiblingProject(siblingProject, declaringType, evt.Name, out location))
        {
            return true;
        }

        var accessor = evt.GetAddMethod(nonPublic: true) ?? evt.GetRemoveMethod(nonPublic: true);
        if (accessor != null && PdbSourceLocator.TryGetMethodSourceLocation(assemblyPath, accessor.MetadataToken, out var pdbLocation))
        {
            location = ToLocation(pdbLocation);
            return true;
        }

        return declaringType != null && TryResolveType(workspace, declaringType, out location);
    }

    private static bool TryResolveTypeInSiblingProject(ProjectState siblingProject, Type type, out Location location)
    {
        location = null;
        var compilation = siblingProject?.GetCompilation();
        if (compilation == null)
        {
            return false;
        }

        if (TryFindStructSymbol(compilation, type, out var structSymbol)
            && structSymbol.Declaration != null)
        {
            location = ToLocation(structSymbol.Declaration.Identifier);
            return location != null;
        }

        if (TryFindEnumSymbol(compilation, type, out var enumSymbol)
            && enumSymbol.Declaration != null)
        {
            location = ToLocation(enumSymbol.Declaration.Identifier);
            return location != null;
        }

        if (TryFindInterfaceSymbol(compilation, type, out var interfaceSymbol)
            && interfaceSymbol.Declaration != null)
        {
            location = ToLocation(interfaceSymbol.Declaration.Identifier);
            return location != null;
        }

        if (TryFindDelegateSymbol(compilation, type, out var delegateDeclaration))
        {
            location = ToLocation(delegateDeclaration.Identifier);
            return location != null;
        }

        return false;
    }

    private static bool TryResolveMethodInSiblingProject(ProjectState siblingProject, Type declaringType, MethodInfo method, out Location location)
    {
        location = null;
        var compilation = siblingProject?.GetCompilation();
        if (compilation == null)
        {
            return false;
        }

        if (TryFindStructSymbol(compilation, declaringType, out var structSymbol))
        {
            var candidates = structSymbol.Methods.Concat(structSymbol.StaticMethods)
                .Where(fs => fs.Declaration != null && string.Equals(fs.Name, method.Name, StringComparison.Ordinal))
                .ToArray();

            var best = SelectMatchingMethod(candidates, method) ?? candidates.FirstOrDefault();
            if (best?.Declaration != null)
            {
                location = ToLocation(best.Declaration.Identifier);
                return location != null;
            }
        }

        if (TryFindInterfaceSymbol(compilation, declaringType, out var interfaceSymbol))
        {
            var match = interfaceSymbol.Methods
                .FirstOrDefault(fs => fs.Declaration != null && string.Equals(fs.Name, method.Name, StringComparison.Ordinal));
            if (match?.Declaration != null)
            {
                location = ToLocation(match.Declaration.Identifier);
                return location != null;
            }
        }

        return false;
    }

    private static bool TryResolvePropertyInSiblingProject(ProjectState siblingProject, Type declaringType, string propertyName, out Location location)
    {
        location = null;
        var compilation = siblingProject?.GetCompilation();
        if (compilation == null || !TryFindStructSymbol(compilation, declaringType, out var structSymbol))
        {
            return false;
        }

        var property = structSymbol.Properties.Concat(structSymbol.StaticProperties)
            .FirstOrDefault(p => p.Declaration != null && string.Equals(p.Name, propertyName, StringComparison.Ordinal));
        if (property?.Declaration != null)
        {
            location = ToLocation(property.Declaration.Identifier);
            return location != null;
        }

        return false;
    }

    private static bool TryResolveFieldInSiblingProject(ProjectState siblingProject, Type declaringType, string fieldName, out Location location)
    {
        location = null;
        var compilation = siblingProject?.GetCompilation();
        if (compilation == null || !TryFindStructSymbol(compilation, declaringType, out var structSymbol)
            || structSymbol.Declaration == null)
        {
            return false;
        }

        foreach (var field in structSymbol.Declaration.Fields)
        {
            if (string.Equals(field.Identifier.Text, fieldName, StringComparison.Ordinal))
            {
                location = ToLocation(field.Identifier);
                return location != null;
            }
        }

        return false;
    }

    private static bool TryResolveEventInSiblingProject(ProjectState siblingProject, Type declaringType, string eventName, out Location location)
    {
        location = null;
        var compilation = siblingProject?.GetCompilation();
        if (compilation == null || !TryFindStructSymbol(compilation, declaringType, out var structSymbol))
        {
            return false;
        }

        var match = structSymbol.Events.Concat(structSymbol.StaticEvents)
            .FirstOrDefault(e => e.Declaration != null && string.Equals(e.Name, eventName, StringComparison.Ordinal));
        if (match?.Declaration != null)
        {
            location = ToLocation(match.Declaration.Identifier);
            return location != null;
        }

        return false;
    }

    /// <summary>
    /// When several G# methods match a CLR method by name (overloads), pick the
    /// one whose parameter arity equals the CLR method's. Best-effort; the
    /// caller will fall back to the first match when nothing better is found.
    /// </summary>
    private static FunctionSymbol SelectMatchingMethod(FunctionSymbol[] candidates, MethodInfo method)
    {
        if (candidates.Length <= 1)
        {
            return candidates.FirstOrDefault();
        }

        var parameterCount = method.GetParameters().Length;
        var arityMatch = candidates.FirstOrDefault(c => c.Parameters.Length == parameterCount);
        return arityMatch ?? candidates.FirstOrDefault();
    }

    private static bool TryFindStructSymbol(Compilation compilation, Type type, out StructSymbol structSymbol)
    {
        structSymbol = null;
        if (compilation == null || type == null)
        {
            return false;
        }

        foreach (var candidate in compilation.GlobalScope.Structs)
        {
            if (MatchesByPackageAndName(candidate.Name, candidate.PackageName, type))
            {
                structSymbol = candidate;
                return true;
            }
        }

        return false;
    }

    private static bool TryFindEnumSymbol(Compilation compilation, Type type, out EnumSymbol enumSymbol)
    {
        enumSymbol = null;
        if (compilation == null || type == null)
        {
            return false;
        }

        foreach (var candidate in compilation.GlobalScope.Enums)
        {
            if (MatchesByPackageAndName(candidate.Name, candidate.PackageName, type))
            {
                enumSymbol = candidate;
                return true;
            }
        }

        return false;
    }

    private static bool TryFindInterfaceSymbol(Compilation compilation, Type type, out InterfaceSymbol interfaceSymbol)
    {
        interfaceSymbol = null;
        if (compilation == null || type == null)
        {
            return false;
        }

        foreach (var candidate in compilation.GlobalScope.Interfaces)
        {
            if (MatchesByPackageAndName(candidate.Name, candidate.PackageName, type))
            {
                interfaceSymbol = candidate;
                return true;
            }
        }

        return false;
    }

    private static bool TryFindDelegateSymbol(Compilation compilation, Type type, out DelegateDeclarationSyntax declaration)
    {
        declaration = null;
        if (compilation == null || type == null)
        {
            return false;
        }

        foreach (var candidate in compilation.GlobalScope.Delegates)
        {
            if (!string.Equals(candidate.Name, type.Name, StringComparison.Ordinal))
            {
                continue;
            }

            foreach (var tree in compilation.SyntaxTrees)
            {
                var match = FindDelegateDeclaration(tree.Root, type.Name);
                if (match != null)
                {
                    declaration = match;
                    return true;
                }
            }
        }

        return false;
    }

    private static DelegateDeclarationSyntax FindDelegateDeclaration(SyntaxNode root, string name)
    {
        if (root is DelegateDeclarationSyntax decl && string.Equals(decl.Identifier.Text, name, StringComparison.Ordinal))
        {
            return decl;
        }

        foreach (var child in root.GetChildren())
        {
            var found = FindDelegateDeclaration(child, name);
            if (found != null)
            {
                return found;
            }
        }

        return null;
    }

    /// <summary>
    /// Matches a G# user-type symbol against a CLR <see cref="Type"/> by the
    /// pair (namespace = G# package name, simple name). For generic types we
    /// strip the CLR backtick-arity suffix (e.g. <c>List`1</c> → <c>List</c>)
    /// because the G# symbol name omits it.
    /// </summary>
    private static bool MatchesByPackageAndName(string symbolName, string symbolPackage, Type type)
    {
        if (!string.Equals(symbolPackage ?? string.Empty, type.Namespace ?? string.Empty, StringComparison.Ordinal))
        {
            return false;
        }

        var clrSimpleName = type.Name;
        var backtick = clrSimpleName.IndexOf('`');
        if (backtick > 0)
        {
            clrSimpleName = clrSimpleName.Substring(0, backtick);
        }

        return string.Equals(symbolName, clrSimpleName, StringComparison.Ordinal);
    }

    private static Location ToLocation(SyntaxToken token)
    {
        if (token == null || token.IsMissing)
        {
            return null;
        }

        var filePath = token.SyntaxTree?.Text?.FileName;
        if (string.IsNullOrEmpty(filePath))
        {
            return null;
        }

        return new Location
        {
            Uri = DocumentUri.FromFileSystemPath(filePath),
            Range = SemanticLookup.ToRange(token),
        };
    }

    private static Location ToLocation(PdbSourceLocator.SourceLocation source)
    {
        if (string.IsNullOrEmpty(source.FilePath))
        {
            return null;
        }

        // PDB sequence points are 1-based; LSP positions are 0-based.
        var startLine = Math.Max(0, source.StartLine - 1);
        var startCol = Math.Max(0, source.StartColumn - 1);
        var endLine = Math.Max(0, source.EndLine - 1);
        var endCol = Math.Max(0, source.EndColumn - 1);

        return new Location
        {
            Uri = DocumentUri.FromFileSystemPath(source.FilePath),
            Range = new Range(new Position(startLine, startCol), new Position(endLine, endCol)),
        };
    }

    private static string TryGetAssemblyPath(Assembly assembly)
    {
        // Delegates to ReferenceResolver.TryGetAssemblyPath which falls back
        // to the per-process registry of original paths for assemblies loaded
        // via MetadataLoadContext.LoadFromByteArray (whose Assembly.Location
        // is the empty string). See #853 / #858.
        return ReferenceResolver.TryGetAssemblyPath(assembly, out var path) ? path : null;
    }
}
