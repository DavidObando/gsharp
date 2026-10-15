// <copyright file="EmbeddedAttributeSource.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.Linq
import System.Text

/// Issue #4922: the compiler-embedded copies of `NullableAttribute` and
/// `NullableContextAttribute`.
///
/// A target framework that publishes neither attribute (netstandard2.0, .NET
/// Framework) can only carry nullability metadata if the emitted assembly
/// declares the two attribute types itself, as csc does: `internal` (and, being closed classes, CLR-sealed)
/// types in `System.Runtime.CompilerServices`, marked with
/// `Microsoft.CodeAnalysis.EmbeddedAttribute` and
/// `CompilerGenerated`. Binding the metadata to a type in the
/// assembly keeps it loadable on every runtime, where a reference to the host's
/// `System.Private.CoreLib` (issue #4921) is not.
///
/// The copies are produced as ordinary G# source in a synthetic syntax tree
/// that joins the binding of the compilation, so they flow through the normal
/// declaration, member-row planning and emission pipeline. (cref:WellKnownReferences) then
/// binds the nullability stamps to the declared constructors, exactly as it
/// would to a copy the user wrote. Nothing is added when the target publishes
/// the attribute, when the source already declares it, or when the target
/// is not a downlevel framework.
internal shared class EmbeddedAttributeSource {
    /// The pseudo file-name prefix of the synthetic trees.
    internal const FileName string = "<gsc-embedded-attributes"

    private const NullableName string = "NullableAttribute"
    private const NullableContextName string = "NullableContextAttribute"
    private const NullableFullName string = "System.Runtime.CompilerServices.NullableAttribute"
    private const NullableContextFullName string = "System.Runtime.CompilerServices.NullableContextAttribute"

    /// Returns whether [`tree`](paramref) is the synthetic tree.
    /// @param tree The tree to test.
    /// @returns `true` for the compiler-embedded attribute tree.
    func IsSyntheticTree(tree SyntaxTree?) bool -> tree != nil &&
        tree
        .Text
        .FileName
        .StartsWith(FileName, StringComparison.Ordinal)

    /// Returns whether [`fullName`](paramref) names one of the embeddable attributes.
    /// @param fullName A package-qualified type name.
    /// @returns `true` for `NullableAttribute` or `NullableContextAttribute` in `System.Runtime.CompilerServices`.
    func IsEmbeddableAttributeName(fullName string) bool -> fullName == NullableFullName ||
        fullName == NullableContextFullName

    /// Returns the trees to bind: [`trees`](paramref), plus the synthetic tree when
    /// the target needs embedded copies.
    /// @param trees The user's syntax trees.
    /// @param references The compilation's references, or `null`.
    /// @returns The input, or the input followed by the synthetic tree.
    func AddEmbeddedAttributes(trees ImmutableArray[SyntaxTree], references ReferenceResolver?) ImmutableArray[
        SyntaxTree
    ] {
        if references == nil || trees.IsDefaultOrEmpty || !references.TargetsDownlevelFramework() {
            return trees
        }
        let needNullable = !references.TryResolvePublishedEmbeddableAttribute(
            NullableFullName,
            out var publishedNullable
        ) &&
            !DeclaresType(trees, NullableName)
        let needContext = !references.TryResolvePublishedEmbeddableAttribute(
            NullableContextFullName,
            out var publishedContext
        ) &&
            !DeclaresType(trees, NullableContextName)
        if !needNullable && !needContext {
            return trees
        }
        // One tree per package: a source file declares a single `package`.
        return trees.Add(SyntaxTree.Parse(SourceText.From(BuildMarkerSource(), FileName + "-marker>"))).Add(
            SyntaxTree.Parse(SourceText.From(BuildSource(needNullable, needContext), FileName + "-nullable>"))
        )
    }

    private func DeclaresType(trees ImmutableArray[SyntaxTree], name string) bool {
        for tree in trees {
            for member in tree.Root.Members {
                let declaration = member as StructDeclarationSyntax
                if declaration != nil && declaration.Identifier.Text == name {
                    return true
                }
            }
        }
        return false
    }

    // csc declares the marker in Microsoft.CodeAnalysis, the two attributes in
    // System.Runtime.CompilerServices.
    private func BuildMarkerSource() string -> `package Microsoft.CodeAnalysis

import System
import System.Runtime.CompilerServices

@CompilerGenerated
internal class EmbeddedAttribute : Attribute {
}
`

    private func BuildSource(needNullable bool, needContext bool) string {
        let source = StringBuilder()
        source.Append(`package System.Runtime.CompilerServices

import System
import Microsoft.CodeAnalysis
`)
        if needNullable {
            source.Append(`
@CompilerGenerated
@EmbeddedAttribute
@AttributeUsage(AttributeTargets.Class | AttributeTargets.Struct | AttributeTargets.Method | AttributeTargets.Event | AttributeTargets.Property | AttributeTargets.Field | AttributeTargets.Parameter | AttributeTargets.ReturnValue | AttributeTargets.GenericParameter, AllowMultiple = false, Inherited = false)
internal class NullableAttribute : Attribute {
    public let NullableFlags []uint8

    init(flag uint8) {
        this.NullableFlags = []uint8{flag}
    }

    init(flags []uint8) {
        this.NullableFlags = flags
    }
}
`)
        }
        if needContext {
            source.Append(`
@CompilerGenerated
@EmbeddedAttribute
@AttributeUsage(AttributeTargets.Class | AttributeTargets.Struct | AttributeTargets.Method | AttributeTargets.Interface | AttributeTargets.Delegate, AllowMultiple = false, Inherited = false)
internal class NullableContextAttribute : Attribute {
    public let Flag uint8

    init(flag uint8) {
        this.Flag = flag
    }
}
`)
        }
        return source.ToString()
    }
}
