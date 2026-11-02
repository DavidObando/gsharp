// <copyright file="GsToCSharpTypeSpeller.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.GeneratorHost

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Text

/// ADR-0145 §B: projects a bound G# (cref:TypeSymbol) onto its C# type
/// spelling for the declaration-only stub the generator host feeds to Roslyn.
/// This is the reverse of cs2gs's `CSharpTypeMapper`: cs2gs maps a Roslyn
/// `ITypeSymbol` onto a canonical G# type; this maps a bound G#
/// (cref:TypeSymbol) back onto a fully-qualified (`global::`) C#
/// type name.
///
/// A type with no faithful C# spelling degrades to the universal upper bound
/// `object` and the loss is recorded on (cref:Fallbacks) so the
/// caller can surface a `GS9204` info (ADR-0145 §H). The stub only has to
/// re-parse, so the fallback never breaks the pipeline.
class GsToCSharpTypeSpeller {
    private let fallbacks List[string] = List[string]()

    /// Gets the distinct type names that could not be spelled and were degraded
    /// to (cref:FallbackType) (ADR-0145 §H / `GS9204`).
    prop Fallbacks IReadOnlyList[string] -> fallbacks

    /// Spells the fully-qualified C# type name for a bound G# type. Returns
    /// (cref:FallbackType) (recorded on (cref:Fallbacks)) when the
    /// type has no faithful C# form.
    /// @param type The bound G# type to spell.
    /// @returns A parseable C# type spelling.
    func Spell(type TypeSymbol?) string -> SpellCore(type, eraseReferenceNullability: false, recordFallback: true)

    private func SpellCore(type TypeSymbol?, eraseReferenceNullability bool, recordFallback bool) string {
        switch type {
            case nil {
                return if recordFallback {
                    Fallback("<null-type>")
                } else {
                    FallbackType
                }
            }
            case annotated is NullabilityAnnotatedTypeSymbol {
                return SpellCore(annotated.BaseType, eraseReferenceNullability, recordFallback)
            }
            case platform is PlatformTypeSymbol {
                return SpellCore(platform.UnderlyingType, eraseReferenceNullability, recordFallback)
            }
            case nullable is NullableTypeSymbol {
                if !eraseReferenceNullability {
                    return SpellCore(nullable.UnderlyingType, eraseReferenceNullability: false, recordFallback) + "?"
                }
                return if NullableLifting.IsAnyValueTypeNullable(nullable) {
                    "global::System.Nullable<${SpellCore(nullable.UnderlyingType, eraseReferenceNullability: true, recordFallback)}>"
                } else {
                    SpellCore(nullable.UnderlyingType, eraseReferenceNullability: true, recordFallback)
                }
            }
            case tp is TypeParameterSymbol {
                return tp.Name
            }
            case seq is SequenceTypeSymbol {
                return "global::System.Collections.Generic.IEnumerable<${SpellCore(seq.ElementType, eraseReferenceNullability, recordFallback)}>"
            }
            case aseq is AsyncSequenceTypeSymbol {
                return "global::System.Collections.Generic.IAsyncEnumerable<${SpellCore(aseq.ElementType, eraseReferenceNullability, recordFallback)}>"
            }
            case map_ is MapTypeSymbol {
                return "global::System.Collections.Generic.Dictionary<${SpellCore(map_.KeyType, eraseReferenceNullability, recordFallback)}, ${SpellCore(map_.ValueType, eraseReferenceNullability, recordFallback)}>"
            }
            case array is ArrayTypeSymbol {
                return SpellCore(array.ElementType, eraseReferenceNullability, recordFallback) + "[]"
            }
            case slice is SliceTypeSymbol {
                // ADR-0145 §B: G#-only shapes project onto their documented CLR shape.
                return "global::System.Span<${SpellCore(slice.ElementType, eraseReferenceNullability, recordFallback)}>"
            }
            case channel is ChannelTypeSymbol {
                return "global::System.Threading.Channels.Channel<${SpellCore(channel.ElementType, eraseReferenceNullability, recordFallback)}>"
            }
            case pointer is PointerTypeSymbol {
                return SpellCore(pointer.PointeeType, eraseReferenceNullability, recordFallback) + "*"
            }
            case byRef is ByRefTypeSymbol {
                // A managed by-ref has no standalone type-position spelling; the
                // pointee is the closest parseable form for a signature stub.
                return SpellCore(byRef.PointeeType, eraseReferenceNullability, recordFallback)
            }
            case tuple is TupleTypeSymbol {
                return "(" + string.Join(
                    ", ",
                    tuple.ElementTypes.Select(
                        (element TypeSymbol) -> SpellCore(element, eraseReferenceNullability, recordFallback)
                    )
                ) +
                    ")"
            }
            case function is FunctionTypeSymbol {
                return SpellFunction(function, eraseReferenceNullability, recordFallback)
            }
            case del is DelegateTypeSymbol {
                return SpellUserType(
                    del.PackageName,
                    del.Name,
                    del.TypeArguments,
                    eraseReferenceNullability,
                    recordFallback
                )
            }
            case enumSymbol is EnumSymbol when enumSymbol.ClrType == nil {
                return SpellUserType(
                    enumSymbol.PackageName,
                    enumSymbol.Name,
                    default(ImmutableArray[TypeSymbol]),
                    eraseReferenceNullability,
                    recordFallback
                )
            }
            case iface is InterfaceSymbol when iface.ClrType == nil {
                return SpellUserType(
                    iface.PackageName,
                    iface.Name,
                    iface.TypeArguments,
                    eraseReferenceNullability,
                    recordFallback
                )
            }
            case structSymbol is StructSymbol when structSymbol.ClrType == nil {
                return SpellUserType(
                    structSymbol.PackageName,
                    structSymbol.Name,
                    structSymbol.TypeArguments,
                    eraseReferenceNullability,
                    recordFallback
                )
            }
            case imported is ImportedTypeSymbol {
                return SpellImported(imported, eraseReferenceNullability, recordFallback)
            }
        }
        // A built-in primitive is a plain TypeSymbol (not a subclass) carrying a
        // CLR type; map it to the C# keyword.
        if type!!.GetType() == typeof(TypeSymbol) && type!!.ClrType != nil && PrimitiveKeywords.TryGetValue(
            type!!.ClrType!!,
            out var keyword
        ) {
            return keyword
        }
        // An imported aggregate (StructSymbol/InterfaceSymbol/EnumSymbol) that
        // carries a CLR type, or any other CLR-backed symbol, spells from its
        // CLR type.
        if type!!.ClrType != nil {
            return SpellClrType(type!!.ClrType, default(ImmutableArray[TypeSymbol]))
        }
        return if recordFallback {
            Fallback(type!!.Name)
        } else {
            FallbackType
        }
    }

    private func SpellFunction(
        function FunctionTypeSymbol,
        eraseReferenceNullability bool,
        recordFallback bool
    ) string {
        let parameters = function
            .ParameterTypes
            .Select((parameter TypeSymbol) -> SpellCore(parameter, eraseReferenceNullability, recordFallback))
            .ToList()
        let isVoid = function.ReturnType == nil || function.ReturnType == TypeSymbol.Void
        if isVoid {
            return if parameters.Count == 0 {
                "global::System.Action"
            } else {
                "global::System.Action<${string.Join(", ", parameters)}>"
            }
        }
        parameters.Add(SpellCore(function.ReturnType, eraseReferenceNullability, recordFallback))
        return "global::System.Func<${string.Join(", ", parameters)}>"
    }

    private func SpellUserType(
        packageName string,
        name string,
        typeArguments ImmutableArray[TypeSymbol],
        eraseReferenceNullability bool,
        recordFallback bool
    ) string {
        let qualified = if string.IsNullOrEmpty(packageName) {
            name
        } else {
            "$packageName.$name"
        }
        var spelled = "global::" + qualified
        if !typeArguments.IsDefaultOrEmpty {
            spelled += "<" + string.Join(
                ", ",
                typeArguments.Select(
                    (argument TypeSymbol) -> SpellCore(argument, eraseReferenceNullability, recordFallback)
                )
            ) +
                ">"
        }
        return spelled
    }

    private func SpellImported(
        imported ImportedTypeSymbol,
        eraseReferenceNullability bool,
        recordFallback bool
    ) string {
        // Prefer the symbolic type arguments (#313 constructions such as
        // `List[T]`) so the open definition + symbolic args reconstruct the
        // strongly-typed shape rather than the type-erased `<object>` closure.
        if !imported.TypeArguments.IsDefaultOrEmpty && imported.OpenDefinition != nil {
            let baseName string? = StripGenericArity(
                imported.OpenDefinition!!.FullName ?? imported.OpenDefinition!!.Name
            )
            let args = string.Join(
                ", ",
                imported.TypeArguments.Select(
                    (argument TypeSymbol) -> SpellCore(argument, eraseReferenceNullability, recordFallback)
                )
            )
            return "global::$baseName<$args>"
        }
        if imported.ClrType != nil {
            return SpellClrType(imported.ClrType, default(ImmutableArray[TypeSymbol]))
        }
        return if recordFallback {
            Fallback(imported.Name)
        } else {
            FallbackType
        }
    }

    private func SpellClrType(clrType Type?, unused ImmutableArray[TypeSymbol]) string {
        if PrimitiveKeywords.TryGetValue(clrType!!, out var keyword) {
            return keyword
        }
        if clrType!!.IsArray {
            let element Type? = clrType!!.GetElementType()
            return (
                if element != nil {
                    SpellClrType(element, default(ImmutableArray[TypeSymbol]))
                } else {
                    FallbackType
                }
            ) +
                "[]"
        }
        if clrType!!.IsPointer {
            let element Type? = clrType!!.GetElementType()
            return (
                if element != nil {
                    SpellClrType(element, default(ImmutableArray[TypeSymbol]))
                } else {
                    FallbackType
                }
            ) +
                "*"
        }
        if clrType!!.IsGenericType && !clrType!!.IsGenericTypeDefinition {
            let definition = clrType!!.GetGenericTypeDefinition()
            let baseName string? = StripGenericArity(definition.FullName ?? definition.Name)
            let args = string.Join(
                ", ",
                clrType!!.GetGenericArguments().Select((a Type) -> SpellClrType(a, default(ImmutableArray[TypeSymbol])))
            )
            return "global::$baseName<$args>"
        }
        let fullName string? = clrType!!.FullName
        if string.IsNullOrEmpty(fullName) {
            // A generic parameter (T) or otherwise anonymous CLR type: use the bare name.
            return if string.IsNullOrEmpty(clrType!!.Name) {
                Fallback("<anonymous-clr-type>")
            } else {
                clrType!!.Name
            }
        }
        return "global::" + StripGenericArity(fullName)
    }

    private func Fallback(typeName string) string {
        if !fallbacks.Contains(typeName) {
            fallbacks.Add(typeName)
        }
        return FallbackType
    }

    shared {
        /// The parseable placeholder emitted when a type has no C# spelling. As in
        /// cs2gs's `CSharpTypeMapper.UnsupportedPlaceholderType`, `object`
        /// is the universal upper bound so the stub always re-parses.
        const FallbackType string = "object"

        /// Spells [`type`](paramref) with reference and unconstrained
        /// nullability annotations erased and value-type `Nullable<T>`
        /// normalized, so two types that project to the same C# constructor
        /// parameter signature produce the same string.
        /// @param type The bound G# type to spell.
        /// @returns The erased C# type spelling.
        internal func SpellErased(type TypeSymbol?) string -> GsToCSharpTypeSpeller().SpellCore(
            type,
            eraseReferenceNullability: true,
            recordFallback: false
        )

        // Reverse of cs2gs CSharpTypeMapper.MapPredefinedName, keyed by the CLR type
        // the built-in G# TypeSymbol carries (e.g. TypeSymbol.Int32.ClrType == typeof(int)).
        private let PrimitiveKeywords Dictionary[Type, string] = Dictionary[Type, string]{
            [typeof(bool)] = "bool",
            [typeof(uint8)] = "byte",
            [typeof(int8)] = "sbyte",
            [typeof(int16)] = "short",
            [typeof(uint16)] = "ushort",
            [typeof(int32)] = "int",
            [typeof(uint32)] = "uint",
            [typeof(int64)] = "long",
            [typeof(uint64)] = "ulong",
            [typeof(float32)] = "float",
            [typeof(float64)] = "double",
            [typeof(decimal)] = "decimal",
            [typeof(char)] = "char",
            [typeof(string)] = "string",
            [typeof(object)] = "object",
            [typeof(nint)] = "nint",
            [typeof(nuint)] = "nuint",
            [typeof(Void)] = "void"
        }

        private func StripGenericArity(metadataName string?) string? {
            var metadataName = metadataName
            if string.IsNullOrEmpty(metadataName) {
                return metadataName
            }
            // `System.Collections.Generic.List`1` -> `System.Collections.Generic.List`.
            let tick = metadataName.IndexOf('`')
            if tick >= 0 {
                metadataName = metadataName.Substring(0, tick)
            }
            // Nested CLR types use `+`; C# spells them with `.`.
            return metadataName!!.Replace('+', '.')
        }
    }
}
