// <copyright file="SymbolSourceOrderComparer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Globalization
import System.Text

/// The compiler's one deterministic order over symbols (issue #4663).
/// @remarks Symbols do not override (cref:object.GetHashCode), so every
/// hash-ordered collection keyed by them (`ImmutableDictionary`,
/// `ImmutableHashSet`, a `Dictionary` after removals) enumerates in
/// identity-hash order. CoreCLR identity hashes come from a per-thread
/// generator: they repeat for the same compiler binary fed the same inputs,
/// and change as soon as anything shifts allocation — an unrelated input
/// file, a different file order, or a differently-built compiler. Any name,
/// counter or emission order derived from such an enumeration is therefore
/// not deterministic, even under `/deterministic`.
///
/// This comparer orders by source facts only, never by input order: the
/// declaration's span start, name and parameter signature (the emitter's
/// MethodDef order since issue #456, kept as the primary keys so existing
/// output does not move), then the declaring file name, the position of any
/// other declaring node (local functions), and the containing type.
internal class SymbolSourceOrderComparer : IComparer[Symbol], IComparer[FunctionSymbol] {
    private init() { }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Compare(x FunctionSymbol?, y FunctionSymbol?) int32 -> this.Compare(cast[Symbol?](x), y)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Compare(x Symbol?, y Symbol?) int32 {
        if object.ReferenceEquals(x, y) {
            return 0
        }
        if x == nil {
            return -1
        }
        if y == nil {
            return 1
        }
        var cmp = PrimaryPosition(x).CompareTo(PrimaryPosition(y))
        if cmp != 0 {
            return cmp
        }
        cmp = string.CompareOrdinal(x.Name ?? string.Empty, y.Name ?? string.Empty)
        if cmp != 0 {
            return cmp
        }
        if x is FunctionSymbol xf && y is FunctionSymbol yf {
            cmp = string.CompareOrdinal(FormatSignature(xf), FormatSignature(yf))
            if cmp != 0 {
                return cmp
            }
        }
        let xNode SyntaxNode? = FirstDeclaringNode(x)
        let yNode SyntaxNode? = FirstDeclaringNode(y)
        cmp = string.CompareOrdinal(FileName(xNode), FileName(yNode))
        if cmp != 0 {
            return cmp
        }
        cmp = (xNode?.Span.Start ?? int32.MaxValue).CompareTo(yNode?.Span.Start ?? int32.MaxValue)
        if cmp != 0 {
            return cmp
        }
        cmp = string.CompareOrdinal(ContainingTypeName(x), ContainingTypeName(y))
        if cmp != 0 {
            return cmp
        }
        cmp = x.Kind.CompareTo(y.Kind)
        if cmp != 0 {
            return cmp
        }
        // Last keys, after everything that orders existing output: the
        // declaration's extent, then the fully qualified signature (the
        // short-name signature above cannot tell List[A.X] from List[B.X]).
        cmp = (xNode?.Span.End ?? int32.MaxValue).CompareTo(yNode?.Span.End ?? int32.MaxValue)
        if cmp != 0 {
            return cmp
        }
        return string.CompareOrdinal(QualifiedSignature(x), QualifiedSignature(y))
    }

    shared {
        /// The shared instance.
        let Instance SymbolSourceOrderComparer = SymbolSourceOrderComparer()

        private const MaxContainmentDepth int32 = 100_000

        /// The emitter's historical primary key: a function's own declaration
        /// start (a local function or literal has none and sorts last), or any
        /// other symbol's first declaring node.
        private func PrimaryPosition(symbol Symbol) int32 -> if symbol is FunctionSymbol function {
            function.Declaration?.Span.Start ?? int32.MaxValue
        } else {
            FirstDeclaringNode(symbol)?.Span.Start ?? int32.MaxValue
        }

        private func FirstDeclaringNode(symbol Symbol) SyntaxNode? {
            let nodes = symbol.DeclaringSyntaxNodes
            return if nodes.IsDefaultOrEmpty {
                default(SyntaxNode?)
            } else {
                nodes[0]
            }
        }

        private func FileName(node SyntaxNode?) string -> node?.SyntaxTree?.Text?.FileName ?? string.Empty

        // Namespace and type segments are distinct: p.A/B is not p/A/B.
        private func ContainingTypeName(symbol Symbol) string {
            let builder = StringBuilder()
            AppendSegment(
                builder,
                "namespace",
                symbol.ContainingType?.ContainingNamespace ?? symbol.ContainingNamespace ?? string.Empty
            )
            let chain = List[TypeSymbol]()
            for var type TypeSymbol? = symbol.ContainingType; type != nil; type = type!!.ContainingType {
                // Containment is acyclic by construction. Truncating the chain would
                // make distinct deep paths tie, so a cycle fails loudly instead.
                if chain.Count >= MaxContainmentDepth {
                    throw InvalidOperationException(
                        "Symbol containment chain exceeds " + MaxContainmentDepth.ToString() + " levels; is it cyclic?"
                    )
                }
                chain.Add(type)
            }
            for var i = chain.Count - 1; i >= 0; i-- {
                AppendNamedTypeSegment(builder, chain[i])
            }
            return builder.ToString()
        }

        private func QualifiedSignature(symbol Symbol) string {
            if symbol is not FunctionSymbol function {
                let key = StringBuilder()
                if symbol is TypeSymbol type {
                    AppendTypeKey(key, type)
                }
                return key.ToString()
            }
            let builder = StringBuilder()
            builder
                .Append(function.TypeParameters.Length.ToString(CultureInfo.InvariantCulture))
                .Append(':')
                .Append(function.ReturnRefKind)
                .Append(':')
                .Append(function.NullableSequenceSpecialization)
                .Append(':')
                .Append(function.IsStatic)
                .Append(':')
            AppendTypeKey(
                builder,
                function.ExplicitInterfaceClauseTarget ?? function.ExplicitInterfaceSlotContainingType
            )
            AppendTypeKey(builder, function.Type)
            builder.Append('(')
            for var i = 0; i < function.Parameters.Length; i++ {
                if i > 0 {
                    builder.Append(',')
                }
                let parameter = function.Parameters[i]
                builder.Append(parameter.RefKind).Append(':').Append(parameter.IsVariadic).Append(':')
                AppendTypeKey(builder, parameter.Type)
            }
            return builder.Append(')').ToString()
        }

        private func AppendSegment(builder StringBuilder, kind string, text string) -> builder
            .Append(kind)
            .Append(':')
            .Append(text.Length.ToString(CultureInfo.InvariantCulture))
            .Append(':')
            .Append(text)
            .Append(';')

        private func AppendArguments(builder StringBuilder, arguments ImmutableArray[TypeSymbol]) {
            builder.Append('[')
            for argument in arguments {
                AppendTypeKey(builder, argument)
                builder.Append(';')
            }
            builder.Append(']')
        }

        private func AppendNamedTypeSegment(builder StringBuilder, type TypeSymbol) {
            AppendSegment(builder, type.GetType().Name, type.Name)
            switch type {
                case structure is StructSymbol {
                    builder.Append(
                        if structure.IsClass {
                            "class:"
                        } else {
                            "struct:"
                        }
                    )
                        .Append(
                        (structure.Definition ?? structure).TypeParameters.Length.ToString(CultureInfo.InvariantCulture)
                    )
                    AppendArguments(builder, structure.EnclosingTypeArguments)
                    AppendArguments(builder, structure.TypeArguments)
                }
                case contract is InterfaceSymbol {
                    builder.Append(
                        (contract.Definition ?? contract).TypeParameters.Length.ToString(CultureInfo.InvariantCulture)
                    )
                    AppendArguments(builder, contract.TypeArguments)
                }
                case delegateType is DelegateTypeSymbol {
                    builder.Append(
                        (delegateType.Definition ?? delegateType)
                            .TypeParameters
                            .Length
                            .ToString(CultureInfo.InvariantCulture)
                    )
                    AppendArguments(builder, delegateType.TypeArguments)
                }
                case enumeration is EnumSymbol {
                    AppendArguments(builder, enumeration.EnclosingTypeArguments)
                }
            }
            builder.Append(';')
        }

        private func AppendTypeKey(builder StringBuilder, type TypeSymbol?) {
            switch type {
                case nil {
                    builder.Append("absent;")
                }
                case parameter is TypeParameterSymbol {
                    builder
                        .Append("parameter:")
                        .Append(parameter.IsMethodTypeParameter)
                        .Append(':')
                        .Append(parameter.Ordinal.ToString(CultureInfo.InvariantCulture))
                        .Append(':')
                    AppendSegment(builder, "name", parameter.Name)
                    builder.Append(ContainingTypeName(parameter))
                }
                case StructSymbol, InterfaceSymbol, DelegateTypeSymbol, EnumSymbol {
                    builder.Append(ContainingTypeName(type!!))
                    AppendNamedTypeSegment(builder, type!!)
                }
                case imported is ImportedTypeSymbol {
                    AppendClrKey(builder, imported.OpenDefinition ?? imported.ClrType)
                    AppendArguments(builder, imported.TypeArguments)
                }
                default {
                    // Reuse the cache's shape walker, never its allocation-dependent
                    // identity leaves. This also retains every nested nullable/platform
                    // position without deriving nullability independently.
                    FunctionTypeSymbol.AppendStructuralKey(builder, type!!, AppendTypeKey, AppendLeafKey)
                }
            }
        }

        private func AppendLeafKey(builder StringBuilder, type TypeSymbol?) {
            if type?.ClrType is {} clrType {
                AppendClrKey(builder, clrType)
            } else {
                AppendSegment(builder, "builtin", type?.Name ?? string.Empty)
            }
        }

        private func AppendClrKey(builder StringBuilder, type Type?) {
            AppendSegment(builder, "assembly", type?.Assembly.FullName ?? string.Empty)
            AppendSegment(builder, "clr", type?.FullName ?? type?.Name ?? string.Empty)
        }

        private func FormatSignature(function FunctionSymbol) string {
            let builder = StringBuilder()
            builder.Append(function.Type?.Name ?? "?")
            builder.Append('(')
            for var i = 0; i < function.Parameters.Length; i++ {
                if i > 0 {
                    builder.Append(',')
                }
                builder.Append(function.Parameters[i].Type?.Name ?? "?")
            }
            builder.Append(')')
            return builder.ToString()
        }
    }
}
