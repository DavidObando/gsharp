// <copyright file="SynthesizedStateMachineType.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering.Async

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Text

/// A compiler-synthesized CLR type that hosts the lowered state machine for
/// an `async` method (see `~/roslyn-async.md` §5). It carries all
/// hoisted control fields (`<>1__state`, `<>t__builder`),
/// the `this`-proxy field, parameter proxies, hoisted user locals, and
/// the per-type pooled awaiter fields.
/// @remarks The type is emitted by (cref:Emit.ReflectionMetadataEmitter)
/// as a nested type on the containing type (or top-level for the script
/// entry-point's async helpers). Its kind — struct vs class — is fixed at
/// construction:
///
/// - <b>struct</b> by default for `async void` / `async Task` / `async Task<T>` / custom task-likes;
/// the no-alloc fast path on synchronously-completing awaits depends on this.
/// - <b>class</b> for async-iterators (always), and as the fallback when EnC stability is needed (not
/// currently supported by GSharp).
///
/// This class is a thin data container. Field population happens in
/// `AsyncStateMachineRewriter` (todo: state-rewriter), which decides
/// hoist set, allocates awaiter slot indices, and registers the synthesized
/// type with its kickoff (cref:FunctionSymbol).
class SynthesizedStateMachineType : TypeSymbol {
    private let fields List[FieldSymbol] = List[FieldSymbol]()
    private let awaiterPoolFields Dictionary[string, FieldSymbol] = Dictionary[string, FieldSymbol](
        StringComparer.Ordinal
    )
    private var materializedStruct StructSymbol?

    /// Initializes a new instance of the (cref:SynthesizedStateMachineType) class.
    /// @param name The mangled type name produced by
    /// (cref:GeneratedNames.StateMachineTypeName).
    /// @param containerKind Whether the type is a `struct` or
    /// `class`; see (cref:StateMachineContainerKind).
    /// @param kickoffMethod The original async method whose body
    /// the state machine implements.
    /// @param builderInfo The resolved BCL builder for the kickoff
    /// method's return type.
    init(
        name string,
        containerKind StateMachineContainerKind,
        kickoffMethod FunctionSymbol,
        builderInfo AsyncMethodBuilderInfo
    ) : base(name) {
        ContainerKind = containerKind
        KickoffMethod = kickoffMethod
        BuilderInfo = builderInfo
    }

    /// Gets the storage kind (struct or class). Spec §5.
    prop ContainerKind StateMachineContainerKind {
        get;
    }

    /// Gets the original async method whose body the state machine implements.
    prop KickoffMethod FunctionSymbol {
        get;
    }

    /// Gets the resolved BCL builder information for the kickoff
    /// method's return type.
    prop BuilderInfo AsyncMethodBuilderInfo {
        get;
    }

    /// Gets or sets the symbolic async result type declared on the kickoff
    /// method before it was widened to `Task<T>`. `null` until
    /// (cref:AsyncStateMachineTypeBuilder) assigns it, immediately after
    /// construction.
    prop ResultTypeSymbol TypeSymbol?

    /// Gets or sets the `<>1__state` field. Every state
    /// machine has one, but it is `null` until the state-machine rewriter
    /// populates it.
    prop StateField FieldSymbol?

    /// Gets or sets the `<>t__builder` field, typed as
    /// (cref:AsyncMethodBuilderInfo.BuilderType). Every state machine has
    /// one, but it is `null` until the state-machine rewriter populates
    /// it.
    prop BuilderField FieldSymbol?

    /// Gets or sets the `<>4__this` field, present only
    /// when the kickoff method is an instance method that captures `this`;
    /// `null` otherwise.
    prop ThisField FieldSymbol?

    /// Gets the read-only sequence of all synthesized fields on
    /// the state machine, in declaration order. Includes the control
    /// fields, the parameter proxies, the hoisted user locals, and the
    /// pooled awaiter slots.
    prop Fields ImmutableArray[FieldSymbol] -> fields.ToImmutableArray()

    /// Appends a field to the synthesized type. Call order
    /// determines emit order; the state-machine rewriter pushes control
    /// fields first, then parameter proxies, then hoisted locals, then
    /// awaiter slots, matching Roslyn's emit order.
    /// @param field The field to append.
    func AddField(field FieldSymbol) {
        if materializedStruct != nil {
            throw InvalidOperationException(
                "Cannot add fields after the synthesized state-machine type has been materialized."
            )
        }
        fields.Add(field)
    }

    /// Registers a pooled awaiter field keyed by its emitted type identity.
    /// @param poolKey The emitted type identity key for the awaiter pool.
    /// @param field The field symbol for the pool slot.
    func RegisterAwaiterPoolField(poolKey string?, field FieldSymbol?) {
        if poolKey == nil {
            throw ArgumentNullException("poolKey")
        }
        if field == nil {
            throw ArgumentNullException("field")
        }
        awaiterPoolFields[poolKey] = field
    }

    /// Gets the pooled awaiter field for the given emitted awaiter type.
    /// @param awaiterClrType The CLR awaiter type.
    /// @param awaiterTypeSymbol The symbolic awaiter type retained for emission.
    /// @returns The awaiter pool field, or `null` if not registered.
    func GetAwaiterPoolField(awaiterClrType Type?, awaiterTypeSymbol TypeSymbol) FieldSymbol? {
        if awaiterClrType == nil {
            return nil
        }
        let key = GetAwaiterPoolKey(awaiterClrType, awaiterTypeSymbol)
        return if awaiterPoolFields.TryGetValue(key, out var field) {
            field
        } else {
            default(FieldSymbol?)
        }
    }

    /// Materializes this synthesized type as a real (cref:StructSymbol)
    /// so later async-rewriter slices can reuse existing bound nodes such as
    /// (cref:GSharp.Core.CodeAnalysis.Binding.BoundFieldAccessExpression), which require a
    /// (cref:StructSymbol) receiver type.
    /// @remarks Calling this method freezes the field list. Struct state machines are
    /// projected as value types; async-iterator class state machines are
    /// projected with (cref:StructSymbol.IsClass) set.
    /// @returns The stable aggregate projection for this state-machine type.
    func MaterializeAsStructSymbol() StructSymbol {
        if materializedStruct != nil {
            return materializedStruct!!
        }
        materializedStruct = StructSymbol(
            name: Name,
            fields: Fields,
            accessibility: Accessibility.Private,
            declaration: nil,
            packageName: KickoffMethod.Package?.Name ?? string.Empty,
            isData: false,
            isInline: false,
            isClass: ContainerKind == StateMachineContainerKind.Class
        )
        return materializedStruct!!
    }

    shared {
        internal const ReferenceAwaiterPoolKey string = "!reference-awaiter"

        internal func GetAwaiterPoolKey(awaiterClrType Type, awaiterTypeSymbol TypeSymbol) string {
            if !awaiterClrType.IsValueType {
                return ReferenceAwaiterPoolKey
            }
            // Issue #2750: distinct symbolic Task<T> results can share the erased
            // TaskAwaiter<object> CLR shape, but their emitted fields cannot.
            let builder = StringBuilder()
            FunctionTypeSymbol.AppendIdentityKey(
                builder,
                awaiterTypeSymbol ?? TypeSymbol.FromClrTypeWithoutNullability(
                    awaiterClrType,
                    NullabilityFreeReason.EmitShape
                )
            )
            return builder.ToString()
        }
    }
}
