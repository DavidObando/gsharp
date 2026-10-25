// <copyright file="SuspensionInference.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding.Suspension

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq

/// ADR-0174 D4: the coloring is <em>inferred</em>. After every body is bound,
/// this pass finds the functions that perform a suspension point — a channel
/// operation, or a call to a function that suspends — and marks them
/// (cref:SuspendingKind.Inferred), iterating to a fixed point over the
/// call graph so mutual recursion converges. It then rewrites every body so a
/// call to a newly-suspending function is typed `ValueTask[R]` and
/// completed the way the binder completes a call to a declared
/// `suspend func`: an implicit await inside a suspending or `async`
/// body, a blocking root bridge (GS0558) elsewhere.
/// @remarks Inference stops at the ADR's boundaries: the synthesized entry point
/// (the root that blocks once), `async` functions (their task is
/// observable), virtual, abstract and overriding methods, interface members
/// and their implementations, constructors, accessors, operators, P/Invoke
/// stubs, `unsafe` functions and bodies containing a `fixed` pin (raw
/// pointers cannot live in a state machine), iterators, `Dispose`, and
/// function literals. A suspension
/// point inside one of those keeps the blocking lowering; GS0558 names the
/// residual blocking bridges. A `go` operand does not color its caller,
/// and a channel operation inside a `lock` body does not either (the
/// monitor is thread-affine).
///
/// Discrimination witnesses (ADR-0154): a mutant that runs a single
/// pass instead of iterating breaks
/// `SuspensionInferenceTests.MutualRecursion_Converges`; a mutant that
/// colors through a `go` operand breaks
/// `SuspensionInferenceTests.GoOperand_DoesNotColorTheCaller`; a mutant
/// that skips the lambda-body rewrite breaks
/// `Adr0174InferredSuspensionEmitTests.Lambda_CallingAnInferredFunction_Runs`.
internal shared class SuspensionInference {
    private class FixedFinder : BoundTreeWalker {
        prop Found bool {
            get;
            private set;
        }

        protected override func VisitFixedStatement(node BoundFixedStatement) {
            Found = true
            base.VisitFixedStatement(node)
        }
    }

    /// Runs inference and the call rewrite over a bound program's bodies.
    /// @param bodies Every function body, keyed by symbol; rewritten in place.
    /// @param entryPoint The program's entry point — synthesized or a user `Main` — which is the root that
    /// blocks and never suspends.
    /// @param references The compilation's reference resolver; when the channel runtime does not resolve
    /// nothing can suspend and the pass is a no-op.
    /// @param diagnostics Receives GS0558 and the re-run async analyses' diagnostics.
    /// @param createMethodGroupAdapter Creates a verifier-safe adapter after inferred suspension has
    /// finalized a method's emitted shape.
    /// @param structs User and synthesized structs whose field initializers also require the rewrite.
    /// @param interfaces User interfaces whose static field initializers also require the rewrite.
    /// @returns The set of functions the pass marked (cref:SuspendingKind.Inferred).
    func Run(
        bodies ImmutableDictionary[FunctionSymbol, BoundBlockStatement].Builder,
        entryPoint FunctionSymbol?,
        references ReferenceResolver?,
        diagnostics ImmutableArray[Diagnostic].Builder,
        createMethodGroupAdapter(FunctionSymbol, BoundMethodGroupExpression) -> BoundExpression,
        structs ImmutableArray[StructSymbol],
        interfaces ImmutableArray[InterfaceSymbol]
    ) ImmutableHashSet[FunctionSymbol] {
        if references == nil {
            return ImmutableHashSet[FunctionSymbol].Empty
        }
        let runtime = ChannelRuntimeBinder(references)
        if !runtime.IsAvailable {
            return ImmutableHashSet[FunctionSymbol].Empty
        }
        let ordered = bodies.Keys.OrderBy(SortKey, StringComparer.Ordinal).ToList()
        let facts = Dictionary[FunctionSymbol, SuspensionPointCollector.Facts]()
        let bag = DiagnosticBag()
        for function in ordered {
            facts[function] = SuspensionPointCollector.Collect(bodies[function])
        }
        let inferred = HashSet[FunctionSymbol]()
        let rejected = HashSet[FunctionSymbol]()
        var changed = true
        while changed {
            changed = false
            for function in ordered {
                if function.IsSuspending || function.IsAsync || rejected.Contains(function) || object.ReferenceEquals(
                    function,
                    entryPoint
                ) ||
                    IsBoundary(function, bodies[function]) {
                    continue
                }
                let own = facts[function]
                if own.HasDirectPoint || own.Callees.Any((callee FunctionSymbol) -> callee.IsSuspending) {
                    var hasRefKindParameter = false
                    for parameter in function.Parameters {
                        if parameter.RefKind == RefKind.None || parameter.DeclaringSyntax == nil {
                            continue
                        }
                        bag.ReportRefKindOnAsyncOrIterator(
                            parameter.DeclaringSyntax.Location,
                            parameter.Name,
                            "newly inferred suspending"
                        )
                        hasRefKindParameter = true
                    }
                    if hasRefKindParameter {
                        rejected.Add(function)
                        continue
                    }
                    function.SuspendingKind = SuspendingKind.Inferred
                    function.AsyncReturnsValueTask = true
                    inferred.Add(function)
                    changed = true
                }
            }
        }
        // ADR-0174 D7: every suspending function carries a hidden leading
        // `Context` parameter, so its channel operations observe the caller's
        // scope. Prepending it here — after the fixed point, after overload
        // resolution and every arity check have run — keeps it out of every
        // user-facing surface while the CLR signature, state-machine hoisting
        // and slot assignment pick it up like any other parameter.
        for function in ordered {
            if function.IsSuspending {
                function.AddHiddenContextParameter(runtime.ContextType)
            } else {
                // A boundary never gains a hidden parameter, but an author who
                // spelled `ctx Context` there still expects the body to observe
                // it — and `case cancelled` to be live (ADR-0174 D7/D8).
                function.AdoptDeclaredContextParameter(runtime.ContextType)
            }
        }
        let newlySuspending = inferred.ToImmutableHashSet()
        for function in ordered {
            let body = bodies[function]
            let rewritten = SuspendingCallRewriter.Rewrite(
                body,
                function,
                object.ReferenceEquals(function, entryPoint),
                newlySuspending,
                runtime,
                bag,
                createMethodGroupAdapter
            )
            if !object.ReferenceEquals(rewritten, body) {
                SyntaxAnchoringWalker.Anchor(rewritten, function.Declaration)
                bodies[function] = rewritten
            }
        }
        for type in structs {
            if type.BaseConstructorInitializer is {} primaryBaseInitializer {
                let primaryConstructor = type
                    .EffectiveExplicitConstructors
                    .FirstOrDefault((constructor ConstructorSymbol) -> constructor.IsSynthesizedFromPrimaryConstructor)
                    ?.Function ??
                    FunctionSymbol(
                    ".ctor",
                    type.PrimaryConstructorParameters,
                    TypeSymbol.Void,
                    declaration: nil,
                    $package: nil,
                    Accessibility.Public,
                    receiverType: type
                ){IsExpressionInitializer = true}
                primaryConstructor.AdoptDeclaredContextParameter(runtime.ContextType)
                type.SetBaseConstructorInitializer(
                    RewriteBaseInitializer(
                        primaryBaseInitializer,
                        primaryConstructor,
                        newlySuspending,
                        runtime,
                        bag,
                        createMethodGroupAdapter
                    )
                )
            }
            for constructor in type.ExplicitConstructors {
                if constructor.BaseInitializer is {} baseInitializer {
                    constructor.SetBaseInitializer(
                        RewriteBaseInitializer(
                            baseInitializer,
                            constructor.Function,
                            newlySuspending,
                            runtime,
                            bag,
                            createMethodGroupAdapter
                        )
                    )
                }
            }
            type.SetStaticFieldInitializers(
                RewriteInitializers(
                    type.StaticFieldInitializers,
                    type,
                    isStatic: true,
                    newlySuspending,
                    runtime,
                    bag,
                    createMethodGroupAdapter
                )
            )
            type.SetStaticInitializerStatements(
                RewriteStaticInitializerStatements(
                    type.StaticInitializerStatements,
                    type,
                    newlySuspending,
                    runtime,
                    bag,
                    createMethodGroupAdapter
                )
            )
            type.SetInstanceFieldInitializers(
                RewriteInitializers(
                    type.InstanceFieldInitializers,
                    type,
                    isStatic: false,
                    newlySuspending,
                    runtime,
                    bag,
                    createMethodGroupAdapter
                )
            )
        }
        for type in interfaces {
            type.SetStaticFieldInitializers(
                RewriteInitializers(
                    type.StaticFieldInitializers,
                    type,
                    isStatic: true,
                    newlySuspending,
                    runtime,
                    bag,
                    createMethodGroupAdapter
                )
            )
        }
        diagnostics.AddRange(bag)
        return newlySuspending
    }

    internal func RewriteInitializers(
        initializers ImmutableDictionary[FieldSymbol, BoundExpression],
        owner TypeSymbol,
        isStatic bool,
        newlySuspending ImmutableHashSet[FunctionSymbol],
        runtime ChannelRuntimeBinder,
        diagnostics DiagnosticBag,
        createMethodGroupAdapter(FunctionSymbol, BoundMethodGroupExpression) -> BoundExpression
    ) ImmutableDictionary[FieldSymbol, BoundExpression] {
        if initializers.IsEmpty {
            return initializers
        }
        let parameters = if !isStatic && owner is StructSymbol structOwner {
            structOwner.PrimaryConstructorParameters
        } else {
            ImmutableArray[ParameterSymbol].Empty
        }
        let container = FunctionSymbol(
            "<field_initializer>",
            parameters,
            TypeSymbol.Void,
            declaration: nil,
            $package: nil,
            Accessibility.Private,
            receiverType: if isStatic {
                default(TypeSymbol?)
            } else {
                owner
            }
        ){
            IsStatic = isStatic,
            IsExpressionInitializer = true,
            StaticOwnerType = if isStatic {
                owner
            } else {
                default(TypeSymbol?)
            },
            LexicalEnclosingType = owner
        }
        container.AdoptDeclaredContextParameter(runtime.ContextType)
        let builder = initializers.ToBuilder()
        for (field, initializer) in initializers.OrderBy(
            (pair KeyValuePair[FieldSymbol, BoundExpression]) -> pair
                .Key
                .DeclaringSyntaxNodes
                .FirstOrDefault()
                ?.Span
                .Start ??
                int32.MaxValue
        )
            .ThenBy((pair KeyValuePair[FieldSymbol, BoundExpression]) -> pair.Key.Name, StringComparer.Ordinal) {
            builder[field] = SuspendingCallRewriter.RewriteInitializer(
                initializer,
                container,
                newlySuspending,
                runtime,
                diagnostics,
                createMethodGroupAdapter
            )
        }
        return builder.ToImmutable()
    }

    /// ADR-0174 D4 "where inference stops": functions whose signature inference may not change.
    /// @param function The function.
    /// @param body Its bound body.
    /// @returns `true` when the function keeps its declared coloring whatever its body does.
    internal func IsBoundary(function FunctionSymbol, body BoundBlockStatement) bool {
        if function.IsTopLevelEntryPoint ||
            function.Declaration == nil ||
            function.IsOpen ||
            function.IsOverride ||
            function.IsAbstract ||
            function.IsPInvoke ||
            function.IsUnsafe ||
            function.IsSpecialName ||
            function.OverriddenMethod != nil ||
            function.ExternalOverriddenMethod != nil ||
            function.ExplicitInterfaceMember != nil ||
            function.ExplicitInterfaceSlot != nil {
            return true
        }
        let name = function.Name
        if name == ".ctor" || name.StartsWith("get_", StringComparison.Ordinal) || name.StartsWith(
            "set_",
            StringComparison.Ordinal
        ) ||
            name.StartsWith("op_", StringComparison.Ordinal) || name.StartsWith("add_", StringComparison.Ordinal) ||
            name.StartsWith("remove_", StringComparison.Ordinal) {
            return true
        }
        if function.IsInstanceMethod && name == "Dispose" && function.Parameters.IsDefaultOrEmpty {
            return true
        }
        if function.ReceiverType is InterfaceSymbol {
            return true
        }
        // An implementation of an interface member occupies a slot whose
        // signature the interface fixed; a same-named, same-arity method on a
        // type that implements that interface is treated as that slot.
        if function.ReceiverType is StructSymbol owner && ImplementsInterfaceMember(owner, function) {
            return true
        }
        return IteratorDetection.ContainsYield(body) || ContainsFixed(body)
    }

    private func RewriteStaticInitializerStatements(
        statements ImmutableArray[BoundStatement],
        owner StructSymbol,
        newlySuspending ImmutableHashSet[FunctionSymbol],
        runtime ChannelRuntimeBinder,
        diagnostics DiagnosticBag,
        createMethodGroupAdapter(FunctionSymbol, BoundMethodGroupExpression) -> BoundExpression
    ) ImmutableArray[BoundStatement] {
        if statements.IsDefaultOrEmpty {
            return statements
        }
        let container = FunctionSymbol(
            "<static-initializer>",
            ImmutableArray[ParameterSymbol].Empty,
            TypeSymbol.Void,
            declaration: nil,
            $package: nil,
            Accessibility.Private
        ){IsStatic = true, IsStaticInitializer = true, StaticOwnerType = owner, LexicalEnclosingType = owner}
        return SuspendingCallRewriter.Rewrite(
            BoundBlockStatement(nil, statements),
            container,
            containerIsRoot: false,
            newlySuspending,
            runtime,
            diagnostics,
            createMethodGroupAdapter
        )
            .Statements
    }

    private func RewriteBaseInitializer(
        initializer BaseConstructorInitializer,
        constructor FunctionSymbol,
        newlySuspending ImmutableHashSet[FunctionSymbol],
        runtime ChannelRuntimeBinder,
        diagnostics DiagnosticBag,
        createMethodGroupAdapter(FunctionSymbol, BoundMethodGroupExpression) -> BoundExpression
    ) BaseConstructorInitializer {
        let arguments = ImmutableArray.CreateBuilder[BoundExpression](initializer.Arguments.Length)
        for argument in initializer.Arguments {
            arguments.Add(
                SuspendingCallRewriter.RewriteInitializer(
                    argument,
                    constructor,
                    newlySuspending,
                    runtime,
                    diagnostics,
                    createMethodGroupAdapter
                )
            )
        }
        return initializer.WithArguments(arguments.MoveToImmutable())
    }

    private func ContainsFixed(body BoundStatement) bool {
        let finder = FixedFinder()
        finder.Visit(body)
        return finder.Found
    }

    private func ImplementsInterfaceMember(owner StructSymbol, function FunctionSymbol) bool {
        for iface in owner.Interfaces {
            for method in iface.Methods {
                if method.Name == function.Name && method.Parameters.Length == function.Parameters.Length {
                    return true
                }
            }
        }
        return false
    }

    private func SortKey(function FunctionSymbol) string {
        let parameterTypes = string.Join(
            ",",
            function.Parameters.Select((p ParameterSymbol) -> p.Type?.Name ?? string.Empty)
        )
        return (function.Package?.Name ?? string.Empty) +
            ":" +
            (function.ReceiverType?.Name ?? string.Empty) +
            ":" +
            function.Name +
            ":" +
            function
            .Parameters
            .Length
            .ToString() +
            ":" +
            parameterTypes
    }
}
