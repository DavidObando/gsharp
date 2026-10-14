// <copyright file="AsyncStateMachineTypeBuilder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering.Async

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable

/// Pure factory that composes the foundation pieces
/// ((cref:AsyncMethodBuilderInfo), (cref:AsyncCaptureWalker),
/// (cref:GeneratedNames), (cref:SynthesizedStateMachineType))
/// into a fully populated state-machine type for one async kickoff method.
/// The returned type carries every field the state-machine rewriter and the
/// emitter will read: control fields (`<>1__state`,
/// `<>t__builder`), the optional `<>4__this` proxy,
/// parameter proxies (one per parameter, named after the parameter itself
/// per Roslyn convention), and hoisted user-local proxies
/// (`<name>5__N`).
/// @remarks This builder produces the type only — it does not generate
/// `MoveNext`, `SetStateMachine`, the constructor, or the rewritten
/// kickoff body. Those are the state-machine rewriter's responsibility and
/// will plug into this type as a follow-up step.
///
/// Builder selection follows Roslyn:
///
/// - Declared inner return type `Void` ⇒ caller observes `System.Threading.Tasks.Task`, builder is
/// `AsyncTaskMethodBuilder`.
/// - Declared inner return type `T` ⇒ caller observes `System.Threading.Tasks.Task<T>`, builder is
/// `AsyncTaskMethodBuilder<T>`.
/// - Return type carries `[AsyncMethodBuilder(typeof(T))]` ⇒ custom builder `T` (or `T<TResult>`).
///
/// Iterator producers (`async IAsyncEnumerable<T>`) take the
/// class container; everything else takes struct.
///
/// Returns `null` if the BCL types `Task` /
/// `Task<T>` cannot be resolved through the supplied
/// (cref:ReferenceResolver) (e.g. an exotic TFM without the standard
/// libraries) or if the kickoff's declared inner return type lacks a CLR
/// projection (e.g. a pure GSharp type that cannot yet be wrapped as
/// `Task<T>` — see ADR-0023 Phase 5.1 limitation). Callers route
/// such cases through a diagnostic rather than dereferencing the null.
shared class AsyncStateMachineTypeBuilder {
    private class AwaiterTypeCollector : BoundTreeWalker {
        init() {
            AwaiterTypes = List[(ClrType Type, TypeSymbol TypeSymbol)]()
        }

        prop AwaiterTypes List[(ClrType Type, TypeSymbol TypeSymbol)] {
            get;
        }

        func Walk(body BoundStatement) {
            Visit(body)
        }

        protected override func VisitAwaitExpression(node BoundAwaitExpression) {
            let awaitableClrType Type? = node.Expression?.Type?.ClrType
            if awaitableClrType != nil {
                let shape AwaitableShape? = AwaitableShape.Resolve(awaitableClrType)
                if shape != nil {
                    AwaiterTypes.Add(
                        (
                            shape.AwaiterType,
                            node.AwaiterTypeSymbol ?? TypeSymbol.FromClrTypeWithoutNullability(
                                shape.AwaiterType,
                                NullabilityFreeReason.EmitShape
                            )
                        )
                    )
                }
            }
            base.VisitAwaitExpression(node)
        }
    }

    /// The base ordinal Roslyn uses for hoisted-local field names
    /// (`<name>5__1`). The leading `5` is the Edit-and-Continue
    /// "generation" identifier; GSharp does not support EnC, but adopts the
    /// convention so produced PEs decompile to the same name shape.
    private const FirstHoistedLocalOrdinal int32 = 1

    /// Builds and populates the state-machine type for [`kickoff`](paramref).
    /// @param kickoff The async function whose body will be lowered
    /// into the returned type's `MoveNext`.
    /// @param loweredBody The kickoff method's lowered body — input to
    /// the capture walker. Must be the post-(cref:Lowerer) form.
    /// @param references The compilation's reference resolver, or
    /// `null` when none is available, in which case the builder
    /// cannot be resolved and this returns `null`. Used to
    /// look up `System.Threading.Tasks.Task[`1]` on the target TFM and to
    /// resolve the builder type's members.
    /// @param ordinal Per-kickoff disambiguator for the synthesized
    /// type's mangled name. The caller (compilation wireup) maintains a
    /// monotonic counter scoped to the kickoff's container so overloads /
    /// generic instantiations do not collide.
    /// @returns The populated state-machine type, or `null`
    /// when the builder cannot be resolved (see remarks on
    /// (cref:AsyncStateMachineTypeBuilder)).
    func Build(
        kickoff FunctionSymbol?,
        loweredBody BoundStatement,
        references ReferenceResolver?,
        ordinal int32 = 0
    ) SynthesizedStateMachineType? {
        if kickoff == nil {
            throw ArgumentNullException("kickoff")
        }
        if !kickoff.IsAsyncOrSuspending {
            throw ArgumentException("Kickoff method is neither declared async nor suspending.", "kickoff")
        }
        let returnClrType Type? = ResolveAsyncReturnClrType(kickoff, references)
        if returnClrType == nil {
            return nil
        }
        // ADR-0174 D4: a suspending function's task is never observed, so it
        // uses the pooling ValueTask builder (amortized zero allocation per
        // invocation). An `async func` keeps the ADR-0023 builders.
        let methodAttributeBuilderType = if kickoff.IsSuspending {
            ResolvePoolingBuilder(kickoff, references)
        } else {
            default(Type?)
        }
        // Resolve returns null when no builder type could be chosen at all --
        // a distinct outcome from resolving one whose members did not bind,
        // which is what IsValid reports. Both mean "no state machine".
        let builderInfo AsyncMethodBuilderInfo? = AsyncMethodBuilderInfo.Resolve(
            returnClrType,
            references,
            methodAttributeBuilderType
        )
        if builderInfo == nil || !builderInfo.IsValid {
            return nil
        }
        let containerKind = if builderInfo.Kind == AsyncMethodBuilderKind.AsyncIterator {
            StateMachineContainerKind.Class
        } else {
            StateMachineContainerKind.Struct
        }
        let typeName = GeneratedNames.StateMachineTypeName(kickoff.Name, ordinal)
        let sm = SynthesizedStateMachineType(typeName, containerKind, kickoff, builderInfo)
        sm.ResultTypeSymbol = kickoff.Type
        let stateField = FieldSymbol(GeneratedNames.StateField, TypeSymbol.Int32, Accessibility.Public)
        sm.AddField(stateField)
        sm.StateField = stateField
        var builderFieldType = TypeSymbol.FromClrTypeWithoutNullability(
            builderInfo.BuilderType,
            NullabilityFreeReason.EmitShape
        )
        // Issues #2381/#2713: match WrapAsTask's symbolic projection guard so
        // the builder field retains every result shape the CLR type erases.
        if TypeSymbol.RequiresSymbolicProjection(kickoff.Type) &&
            builderInfo.BuilderType is {IsConstructedGenericType: true} builderClrType {
            builderFieldType = ImportedTypeSymbol.GetConstructed(
                builderClrType,
                builderClrType.GetGenericTypeDefinition(),
                ImmutableArray.Create(kickoff.Type)
            )
        }
        let builderField = FieldSymbol(GeneratedNames.BuilderField, builderFieldType, Accessibility.Public)
        sm.AddField(builderField)
        sm.BuilderField = builderField
        if kickoff.ReceiverType != nil {
            let thisField = FieldSymbol(GeneratedNames.ThisField, kickoff.ReceiverType, Accessibility.Public)
            sm.AddField(thisField)
            sm.ThisField = thisField
        }
        let hoist = AsyncCaptureWalker.Analyze(loweredBody, kickoff.EmittedParameters)
        for parameter in hoist.Parameters {
            sm.AddField(FieldSymbol(parameter.Name, parameter.Type, Accessibility.Public))
        }
        var hoistedOrdinal = FirstHoistedLocalOrdinal
        for local in hoist.Locals {
            let fieldName = GeneratedNames.HoistedLocalField(local.Name, hoistedOrdinal++)
            sm.AddField(FieldSymbol(fieldName, local.Type, Accessibility.Public))
        }
        for spillLocal in hoist.SpillLocals {
            sm.AddField(FieldSymbol(spillLocal.Name, spillLocal.Type, Accessibility.Public))
        }
        // Awaiter pool fields: one per distinct awaiter type. Reference-typed
        // awaiters collapse to a single System.Object field.
        let awaiterFields = CollectAwaiterPoolFields(loweredBody)
        var awaiterOrdinal = 1
        for (poolKey, fieldType) in awaiterFields {
            let fieldName = GeneratedNames.AwaiterField(awaiterOrdinal++)
            let field = FieldSymbol(fieldName, fieldType, Accessibility.Public)
            sm.AddField(field)
            sm.RegisterAwaiterPoolField(poolKey, field)
        }
        return sm
    }

    private func CollectAwaiterPoolFields(body BoundStatement) List[(PoolKey string, FieldType TypeSymbol)] {
        let collector = AsyncStateMachineTypeBuilder.AwaiterTypeCollector()
        collector.Walk(body)
        let result = List[(PoolKey string, FieldType TypeSymbol)]()
        let seen = HashSet[string](StringComparer.Ordinal)
        var hasReferenceAwaiter = false
        for (awaiterClrType, awaiterTypeSymbol) in collector.AwaiterTypes {
            if awaiterClrType.IsValueType {
                let poolKey = SynthesizedStateMachineType.GetAwaiterPoolKey(awaiterClrType, awaiterTypeSymbol)
                if seen.Add(poolKey) {
                    result.Add((poolKey, awaiterTypeSymbol))
                }
            } else {
                if !hasReferenceAwaiter {
                    hasReferenceAwaiter = true
                    result.Add((SynthesizedStateMachineType.ReferenceAwaiterPoolKey, awaiterTypeSymbol))
                }
            }
        }
        return result
    }

    private func ResolvePoolingBuilder(kickoff FunctionSymbol, references ReferenceResolver?) Type? {
        if references == nil {
            return nil
        }
        let name = if kickoff.Type == TypeSymbol.Void {
            "System.Runtime.CompilerServices.PoolingAsyncValueTaskMethodBuilder"
        } else {
            "System.Runtime.CompilerServices.PoolingAsyncValueTaskMethodBuilder`1"
        }
        return if references.TryResolveType(name, requireExternalVisibility: false, out var builder) {
            builder
        } else {
            default(Type?)
        }
    }

    private func ResolveAsyncReturnClrType(kickoff FunctionSymbol, references ReferenceResolver?) Type? {
        if references == nil {
            return nil
        }
        if kickoff.IsAsyncVoid {
            return typeof(Void)
        }
        // Issue #1918: honor an explicit `ValueTask` / `ValueTask[T]` async
        // return-type annotation by resolving the ValueTask wrapper instead
        // of the default Task wrapper.
        let wrapperName = if kickoff.AsyncReturnsValueTask {
            "System.Threading.Tasks.ValueTask"
        } else {
            "System.Threading.Tasks.Task"
        }
        let wrapperOpenName = wrapperName + "`1"
        if kickoff.Type == TypeSymbol.Void {
            return if references.TryResolveType(wrapperName, requireExternalVisibility: false, out var taskType) {
                taskType
            } else {
                default(Type?)
            }
        }
        // Issue #530: for a nullable value type (e.g. `int32?`), the CLR type
        // argument must be `Nullable<T>` (not bare `T`) so the async state
        // machine's builder type (`Task<Nullable<int>>`) matches the kickoff's
        // return type produced by WrapAsTask.
        var inner Type?
        if kickoff.Type is NullableTypeSymbol nullable &&
            nullable
            .UnderlyingType
            ?.ClrType is {IsValueType: true} innerVt {
            if !references.TryResolveType(
                "System.Nullable`1",
                requireExternalVisibility: false,
                out var nullableOpen
            ) ||
                nullableOpen == nil {
                return nil
            }
            inner = nullableOpen.MakeGenericType(references.MapClrTypeToReferences(innerVt)!!)
        } else {
            // Issue #2381: an imported generic type closed over a
            // same-compilation TypeBuilder-backed argument (e.g.
            // `List[DiagnosticCheck]`, `Dictionary[string, DiagnosticCheck]`,
            // `List[List[DiagnosticCheck]]`) caches an object-erased
            // `ClrType` (`List<object>`) from binding time, before the
            // argument's own CLR type existed. Reconstruct the true closed
            // shape from the CURRENT state of the type arguments so the
            // async builder / kickoff signature carry the real generic
            // instantiation instead of the erased approximation.
            inner = if kickoff.Type is ImportedTypeSymbol importedKickoffType {
                importedKickoffType.ReifyClosedClrType()
            } else {
                kickoff.Type?.ClrType
            }
            if inner == nil {
                // Issue #1785: a nullable same-compilation user value type
                // (`UserStruct?`/`UserEnum?`) reaches here too — the
                // `IsValueType: true` probe above uses `nullable.UnderlyingType.ClrType`,
                // which is null for a user struct/enum, so it fails to match
                // and falls through. Erase to `object` the same way the bare
                // struct/enum case does, using symbol-based detection instead
                // of the null ClrType.
                //
                // Issue #2030 (gap 1): a bare or nullable-wrapped open method
                // type parameter (`U` / `U?`) has no `ClrType` either — it
                // reaches here the same way. Erase to `object` too, so the
                // reflection-only pipeline below can still resolve a
                // `Task<object>` / `AsyncTaskMethodBuilder<object>` shape to
                // discover the builder's members (Create/Start/SetResult/…).
                // The SM's actual field/return type is re-widened to the real
                // open type parameter afterward (see the `builderFieldType`
                // override in `Build` and `ResultTypeSymbol`), so the emitted
                // IL still carries `!!0`/`!0`, not `object`.
                // open type parameter afterward (see the `builderFieldType`
                // override in `Build` and `ResultTypeSymbol`), so the emitted
                // IL still carries `!!0`/`!0`, not `object`.
                //
                // Issues #2381/#2713: erase every symbolic projection only
                // for reflection-based builder discovery; emission restores it.
                if TypeSymbol.RequiresSymbolicProjection(
                    Invariant.Required(
                        kickoff.Type,
                        "an async kickoff method has a return type",
                        expression: "kickoff.Type"
                    )
                ) {
                    inner = references.MapClrTypeToReferences(typeof(object))
                } else {
                    return nil
                }
            } else {
                // Project the element CLR type onto the resolver's reference set before
                // constructing Task`1. Under the SDK build path Task`1 is loaded via a
                // MetadataLoadContext, and MakeGenericType requires the type argument to
                // come from that same context (issues #290 and #291).
                inner = references.MapClrTypeToReferences(inner)
            }
        }
        return if references.TryResolveType(wrapperOpenName, requireExternalVisibility: false, out var open_) {
            open_!!.MakeGenericType(inner!!)
        } else {
            default(Type?)
        }
    }
}
