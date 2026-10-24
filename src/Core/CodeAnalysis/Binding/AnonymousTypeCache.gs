// <copyright file="AnonymousTypeCache.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import System.Collections.Generic
import System.Collections.Immutable
import System.Text

/// Per-compile-pass cache of synthesized anonymous-class types (issue #2224,
/// per the repo owner's design comment on that issue). Mirrors Roslyn's
/// anonymous-type cache: two anonymous-class literals (`object { let ... }`)
/// with the same member names, in the same order, and the same member types
/// unify to the SAME synthesized (cref:StructSymbol) within one
/// compile pass, so their instances share a single synthesized backing type
/// exactly like two `new { ... }` expressions of the same shape share
/// one `<>f__AnonymousType` in Roslyn.
internal class AnonymousTypeCache {
    private let byShape Dictionary[string, StructSymbol] = Dictionary[string, StructSymbol]()
    private let symbols List[StructSymbol] = List[StructSymbol]()
    private var counter int32

    /// Gets every distinct synthesized anonymous type created so far in this cache, in creation order.
    prop Symbols IReadOnlyList[StructSymbol] -> symbols

    /// Issue #5281: creates a cache for one body-binding pass, seeded with every shape this cache
    /// holds and continuing its counter. The body pass mutates only the copy, so repeated or
    /// concurrent `BindProgram` calls over one declaration scope neither race on this cache nor
    /// see types created by another call's (possibly superseded) bodies. This cache must not be
    /// written after the declaration pass completes.
    /// @returns An independent cache with the same shapes, symbols and counter.
    func CreateBodyPassCopy() AnonymousTypeCache {
        let copy = AnonymousTypeCache()
        for pair in byShape {
            copy.byShape[pair.Key] = pair.Value
        }
        copy.symbols.AddRange(symbols)
        copy.counter = counter
        return copy
    }

    /// Returns the cached synthesized type for the given ordered member
    /// shape (name + type, order-sensitive like C# anonymous types),
    /// creating and caching a new one on first use.
    /// @param members The member names and types, in declaration order.
    /// @param packageName The package the synthesized type is emitted into.
    /// @param useFields When true (a `data object`) the synthesized type exposes public
    /// read-only FIELDS (data-class style) so the value-semantics machinery
    /// (`with`/copy, Equals/GetHashCode/ToString/Deconstruct) works; when
    /// false (a plain `object`) it exposes get-only auto-PROPERTIES so
    /// reflection-based consumers (EF Core) and cs2gs-originated literals see
    /// `PropertyInfo` members.
    /// @returns The (cached) synthesized anonymous-class (cref:StructSymbol).
    func GetOrCreate(
        members IReadOnlyList[(Name string, Type TypeSymbol)],
        packageName string?,
        useFields bool
    ) StructSymbol {
        let key = (
            if useFields {
                "data;"
            } else {
                "plain;"
            }
        ) +
            BuildKey(members)
        if byShape.TryGetValue(key, out var existing) {
            return existing
        }
        // Roslyn-style synthesized name; unique per distinct shape within
        // this cache (one per compile pass).
        let typeName = "<>AnonymousType${counter++}"
        let ctorParams = ImmutableArray.CreateBuilder[ParameterSymbol](members.Count)
        if useFields {
            // ADR-0146 / issue #2243: a `data object { ... }` gets public,
            // read-only FIELDS (data-class style, ADR-0029). Fields are what
            // the value-semantics machinery needs: DataStructSynthesizer's
            // Equals/GetHashCode/ToString/Deconstruct read them directly, and
            // the `with`/copy lowering (ExpressionBinder.LowerCopyOrWith)
            // enumerates `StructSymbol.Fields`. The literal is emitted as a
            // composite struct literal (initobj + stfld) exactly like an
            // ordinary `data struct Foo(x int32)`.
            let dataFields = ImmutableArray.CreateBuilder[FieldSymbol](members.Count)
            for (name, type) in members {
                dataFields.Add(FieldSymbol(name, type, Accessibility.Public, isReadOnly: true))
                ctorParams.Add(ParameterSymbol(name, type))
            }
            let dataSymbol = StructSymbol(
                typeName,
                dataFields.MoveToImmutable(),
                Accessibility.Public,
                declaration: nil,
                packageName: packageName ?? string.Empty,
                isData: true,
                isInline: false,
                isClass: false,
                primaryConstructorParameters: ctorParams.MoveToImmutable()
            )
            dataSymbol.IsAnonymousLiteral = true
            dataSymbol.SetImplementedClrInterfaces(
                ImmutableArray.Create(DataEqualityMemberModel.CreateSelfEquatable(dataSymbol))
            )
            byShape[key] = dataSymbol
            symbols.Add(dataSymbol)
            return dataSymbol
        }
        let properties = ImmutableArray.CreateBuilder[PropertySymbol](members.Count)
        for (name, type) in members {
            // Get-only auto-property (C# anonymous-type parity, issue #2224
            // rubber-duck follow-up): a private readonly backing field plus a
            // public get-only property wrapping it — mirroring the real IL
            // shape of a C# anonymous type (and required so EF Core's
            // reflection-based model building, which filters for
            // PropertyInfo, recognizes the synthesized member; see
            // ExpressionTreeLowerer.BuildUserConstructorExpression's 3-arg
            // Expression.New(ctor, args, members) using these PropertySymbols).
            // The synthesized primary constructor assigns the backing field
            // directly (ReflectionMetadataEmitter.EmitClassPrimaryConstructorBodyBytes
            // / TypeDefEmitter.EmitClassPrimaryConstructor fall back to a
            // property's BackingField when no same-named field exists), and
            // DataStructSynthesizer's Equals/GetHashCode/ToString/Deconstruct
            // (ADR-0029) read the backing fields via
            // DataStructSynthesizer.GetSynthesisFields.
            let backingField = FieldSymbol("<$name>k__BackingField", type, Accessibility.Private, isReadOnly: true)
            let property = PropertySymbol(
                name,
                type,
                Accessibility.Public,
                hasGetter: true,
                hasSetter: false,
                isAutoProperty: true,
                isVirtual: false,
                isOverride: false
            ){BackingField = backingField}
            properties.Add(property)
            ctorParams.Add(ParameterSymbol(name, type))
        }
        // A plain `object { ... }` keeps the proven issue-#2224 shape:
        // isData:true so the emitter reserves a real newobj-callable primary
        // constructor row (see ReflectionMetadataEmitter's classPrimaryCtorRows
        // branch) and the literal compiles to a BoundConstructorCallExpression.
        let symbol = StructSymbol(
            typeName,
            ImmutableArray[FieldSymbol].Empty,
            Accessibility.Public,
            declaration: nil,
            packageName: packageName ?? string.Empty,
            isData: true,
            isInline: false,
            isClass: false,
            primaryConstructorParameters: ctorParams.MoveToImmutable()
        )
        symbol.HasAnonymousConstructorMembers = true
        symbol.IsAnonymousLiteral = true
        symbol.SetImplementedClrInterfaces(ImmutableArray.Create(DataEqualityMemberModel.CreateSelfEquatable(symbol)))
        symbol.SetProperties(properties.MoveToImmutable())
        byShape[key] = symbol
        symbols.Add(symbol)
        return symbol
    }

    shared {
        private func BuildKey(members IReadOnlyList[(Name string, Type TypeSymbol)]) string {
            let sb = StringBuilder()
            for (name, type) in members {
                sb.Append(name).Append(':')
                FunctionTypeSymbol.AppendIdentityKey(sb, type)
                sb.Append(';')
            }
            return sb.ToString()
        }
    }
}
