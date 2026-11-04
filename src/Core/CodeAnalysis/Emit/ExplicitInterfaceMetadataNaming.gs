// <copyright file="ExplicitInterfaceMetadataNaming.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis.Symbols
import System.Collections.Immutable

/// ADR-0149: an explicit-interface qualifier clause (`func (IFoo) M(...)`
/// / `prop (IFoo) P T`) keeps its declared, source-visible name plain —
/// diagnostics, reflection `Name` lookups by the ordinary member name,
/// and hand-authored G# source never see anything but `M` / `P`.
/// But the CLR metadata name of the emitted MethodDef/PropertyDef row (and,
/// for a property, its `get_`/`set_` accessor MethodDefs) DOES need
/// to be collision-free: two explicit implementations of DIFFERENT interfaces
/// that share a member name (the entire point of the feature) would otherwise
/// emit two MethodDefs with the identical name and signature in the same
/// type — legal at the raw metadata level, but indistinguishable to
/// reflection APIs that look a member up by name (and needlessly fragile).
/// This helper synthesizes a qualified, C#-explicit-impl-style metadata name
/// (`Interface.Member`, or `Package.Interface.Member` when the
/// interface has a package/namespace) that is unique per (interface, member)
/// slot — the same uniqueness key (cref:DiagnosticBag.ReportDuplicateExplicitInterfaceImplementation)
/// (GS0495) already enforces at the source level, so within a single valid
/// compilation this synthesized name can never collide with another such
/// synthesized name, nor (since it always contains at least one `.`,
/// which no plain G# identifier can contain) with any ordinary member's name.
internal shared class ExplicitInterfaceMetadataNaming {
    /// Returns the collision-free CLR metadata name for a member explicitly
    /// implementing [`target`](paramref)'s [`memberName`](paramref)
    /// member, or [`memberName`](paramref) itself unchanged when
    /// [`target`](paramref) is `null` (not an explicit
    /// implementation, or not yet resolved — the latter only for a program
    /// that already has a GS0492/GS0493 error and will not reach emit).
    /// @param memberName The declared (plain, source-visible) member name.
    /// @param target The resolved explicit-interface clause target, or `null`.
    /// @returns A collision-free metadata name, or [`memberName`](paramref) unchanged.
    internal func GetMetadataName(memberName string, target TypeSymbol?) string {
        if target == nil {
            return memberName
        }
        if target is InterfaceSymbol sourceInterface {
            let qualifiedInterfaceName = FormatSourceInterfaceName(sourceInterface)
            return if string.IsNullOrEmpty(sourceInterface.PackageName) {
                "$qualifiedInterfaceName.$memberName"
            } else {
                "${sourceInterface.PackageName}.$qualifiedInterfaceName.$memberName"
            }
        }
        let interfaceName string? = if target is ImportedTypeSymbol imported && imported.OpenDefinition != nil {
            imported.OpenDefinition.FullName
        } else {
            target.ClrType?.FullName
        }
        return "${interfaceName ?? target.Name}.$memberName"
    }

    private func FormatSourceInterfaceName(sourceInterface InterfaceSymbol) string -> FormatUserAggregateName(
        sourceInterface.Definition ?? sourceInterface,
        sourceInterface.EnclosingTypeArguments,
        sourceInterface.TypeArguments,
        includePackage: false
    )

    private func FormatUserAggregateName(
        definition TypeSymbol,
        enclosingArgs ImmutableArray[TypeSymbol],
        ownArgs ImmutableArray[TypeSymbol],
        includePackage bool
    ) string {
        let ownSegment = if !ownArgs.IsDefaultOrEmpty {
            let ownParts = [ownArgs.Length]string
            for var i = 0; i < ownArgs.Length; i++ {
                ownParts[i] = FormatTypeArgument(ownArgs[i])
            }
            "${definition.Name}[${string.Join(", ", ownParts)}]"
        } else {
            definition.Name
        }
        let containers = System.Collections.Generic.List[TypeSymbol]()
        var current = definition.ContainingType
        while current != nil {
            containers.Add(current)
            current = current.ContainingType
        }
        var body string
        if containers.Count == 0 {
            if !enclosingArgs.IsDefaultOrEmpty {
                let argParts = [enclosingArgs.Length]string
                for var i = 0; i < enclosingArgs.Length; i++ {
                    argParts[i] = FormatTypeArgument(enclosingArgs[i])
                }
                body = "${ownSegment}[${string.Join(", ", argParts)}]"
            } else {
                body = ownSegment
            }
        } else {
            containers.Reverse()
            let parts = [containers.Count + 1]string
            var offset = 0
            for var i = 0; i < containers.Count; i++ {
                let containerDef = (containers[i] as StructSymbol)?.Definition ?? containers[i]
                let arity = if containerDef is StructSymbol structDef {
                    structDef.DeclaredTypeParameters.Length
                } else {
                    0
                }
                if arity > 0 && !enclosingArgs.IsDefaultOrEmpty && offset + arity <= enclosingArgs.Length {
                    let argParts = [arity]string
                    for var j = 0; j < arity; j++ {
                        argParts[j] = FormatTypeArgument(enclosingArgs[offset + j])
                    }
                    parts[i] = "${containerDef.Name}[${string.Join(", ", argParts)}]"
                    offset += arity
                } else {
                    parts[i] = containerDef.Name
                }
            }
            parts[containers.Count] = ownSegment
            body = string.Join(".", parts)
        }
        if !includePackage {
            return body
        }
        let packageName = switch definition {
            case s is StructSymbol: s.PackageName
            case i is InterfaceSymbol: i.PackageName
            case e is EnumSymbol: e.PackageName
            case d is DelegateTypeSymbol: d.PackageName
            default: string.Empty
        }
        return if string.IsNullOrEmpty(packageName) {
            body
        } else {
            "$packageName.$body"
        }
    }

    private func FormatTypeArgument(type TypeSymbol) string {
        switch type {
            case annotated is NullabilityAnnotatedTypeSymbol {
                return FormatTypeArgument(annotated.BaseType)
            }
            case platform is PlatformTypeSymbol {
                return FormatTypeArgument(platform.UnderlyingType)
            }
            case nullable is NullableTypeSymbol {
                return "${FormatTypeArgument(nullable.UnderlyingType)}?"
            }
            case slice is SliceTypeSymbol {
                return "[]${FormatTypeArgument(slice.ElementType)}"
            }
            case array is ArrayTypeSymbol {
                return "[${array.Length}]${FormatTypeArgument(array.ElementType)}"
            }
            case rect is RectangularArrayTypeSymbol {
                return "[${System.String(',', rect.Rank - 1)}]${FormatTypeArgument(rect.ElementType)}"
            }
            case byRef is ByRefTypeSymbol {
                return "${FormatTypeArgument(byRef.PointeeType)}&"
            }
            case ptr is PointerTypeSymbol {
                return "*${FormatTypeArgument(ptr.PointeeType)}"
            }
            case tuple is TupleTypeSymbol {
                let elemParts = [tuple.ElementTypes.Length]string
                for var i = 0; i < tuple.ElementTypes.Length; i++ {
                    elemParts[i] = FormatTypeArgument(tuple.ElementTypes[i])
                }
                return "(${string.Join(", ", elemParts)})"
            }
            case mapType is MapTypeSymbol {
                return "map[${FormatTypeArgument(mapType.KeyType)}, ${FormatTypeArgument(mapType.ValueType)}]"
            }
            case seq is SequenceTypeSymbol {
                return "sequence[${FormatTypeArgument(seq.ElementType)}]"
            }
            case aseq is AsyncSequenceTypeSymbol {
                return "async sequence[${FormatTypeArgument(aseq.ElementType)}]"
            }
            case ch is ChannelTypeSymbol {
                return ChannelTypeSymbol.FormatName(FormatTypeArgument(ch.ElementType), ch.Direction)
            }
            case fn is FunctionTypeSymbol {
                let hasVariadicFlags = !fn.IsVariadic.IsDefaultOrEmpty
                let paramParts = [fn.ParameterTypes.Length]string
                for var i = 0; i < fn.ParameterTypes.Length; i++ {
                    if hasVariadicFlags && fn.IsVariadic[i] {
                        let variadicParam = if fn.ParameterTypes[i] is SliceTypeSymbol slice {
                            FormatTypeArgument(slice.ElementType)
                        } else {
                            FormatTypeArgument(fn.ParameterTypes[i])
                        }
                        paramParts[i] = "...$variadicParam"
                    } else {
                        paramParts[i] = FormatTypeArgument(fn.ParameterTypes[i])
                    }
                }
                let retPart = if fn.ReturnType != nil && !object.ReferenceEquals(fn.ReturnType, TypeSymbol.Void) {
                    FormatTypeArgument(fn.ReturnType)
                } else {
                    "void"
                }
                return "(${string.Join(", ", paramParts)}) -> $retPart"
            }
            case fnPtr is FunctionPointerTypeSymbol {
                let paramParts = [fnPtr.ParameterTypes.Length]string
                for var i = 0; i < fnPtr.ParameterTypes.Length; i++ {
                    paramParts[i] = FormatTypeArgument(fnPtr.ParameterTypes[i])
                }
                if fnPtr.IsManaged {
                    return if !object.ReferenceEquals(fnPtr.ReturnType, TypeSymbol.Void) {
                        "*func(${string.Join(", ", paramParts)}) ${FormatTypeArgument(fnPtr.ReturnType)}"
                    } else {
                        "*func(${string.Join(", ", paramParts)})"
                    }
                }
                let retPart = if !object.ReferenceEquals(fnPtr.ReturnType, TypeSymbol.Void) {
                    FormatTypeArgument(fnPtr.ReturnType)
                } else {
                    "void"
                }
                if fnPtr.IsUnmanagedExtended {
                    let convSuffix = if !fnPtr.UnmanagedConventions.IsDefaultOrEmpty {
                        "[${string.Join(", ", fnPtr.UnmanagedConventions)}]"
                    } else {
                        string.Empty
                    }
                    return "unmanaged$convSuffix (${string.Join(", ", paramParts)}) -> $retPart"
                }
                let convLabel = switch fnPtr.CallingConvention {
                    case System.Runtime.InteropServices.CallingConvention.StdCall: "Stdcall"
                    case System.Runtime.InteropServices.CallingConvention.ThisCall: "Thiscall"
                    case System.Runtime.InteropServices.CallingConvention.FastCall: "Fastcall"
                    default: fnPtr.CallingConvention.ToString()
                }
                return "unmanaged[$convLabel] (${string.Join(", ", paramParts)}) -> $retPart"
            }
            case s is StructSymbol {
                return FormatUserAggregateName(
                    s.Definition ?? s,
                    s.EnclosingTypeArguments,
                    s.TypeArguments,
                    includePackage: true
                )
            }
            case i is InterfaceSymbol {
                return FormatUserAggregateName(
                    i.Definition ?? i,
                    i.EnclosingTypeArguments,
                    i.TypeArguments,
                    includePackage: true
                )
            }
            case e is EnumSymbol {
                return FormatUserAggregateName(
                    e.Definition ?? e,
                    e.EnclosingTypeArguments,
                    ImmutableArray[TypeSymbol].Empty,
                    includePackage: true
                )
            }
            case d is DelegateTypeSymbol {
                return FormatUserAggregateName(
                    d.Definition ?? d,
                    ImmutableArray[TypeSymbol].Empty,
                    d.TypeArguments,
                    includePackage: true
                )
            }
            case imp is ImportedTypeSymbol when !imp.TypeArguments.IsDefaultOrEmpty {
                let argParts = [imp.TypeArguments.Length]string
                for var i = 0; i < imp.TypeArguments.Length; i++ {
                    argParts[i] = FormatTypeArgument(imp.TypeArguments[i])
                }
                let baseName = imp.OpenDefinition?.FullName ?? imp.ClrType?.FullName ?? imp.Name
                return "$baseName[${string.Join(", ", argParts)}]"
            }
            case impPlain is ImportedTypeSymbol when impPlain.ClrType?.FullName is {} fullName {
                return fullName
            }
            default {
                return type.Name
            }
        }
    }
}
