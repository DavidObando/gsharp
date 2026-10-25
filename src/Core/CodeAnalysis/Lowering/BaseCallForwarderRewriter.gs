// <copyright file="BaseCallForwarderRewriter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection
import System.Runtime.CompilerServices

/// Issues #1467 and #2667: routes `base.M(args)` calls that appear inside
/// async / iterator / suspending method bodies, or inside a function literal
/// or a `go` operand nested in any instance member, through a synthesized
/// non-virtual forwarder method on the containing class.
/// @remarks A base-class call lowers to a non-virtual `call instance R Base::M(...)`.
/// The CLR verifier requires the `this` argument of such a non-virtual call
/// to a (virtual) base method to be the calling method's own `this`
/// (`ldarg.0`). Inside an async / iterator state machine the original
/// `this` is hoisted into a `<>4__this` field, so the base call's
/// receiver is a field load — producing an ilverify `ThisMismatch` error.
/// A function literal is emitted as a method of a closure class that holds
/// the captured `this` in a field, so a base call inside it has the same
/// problem (ADR-0192 follow-on 2: a translated C# local function calling
/// `base.Crawlpos()`). Roslyn forwards those calls the same way.
///
/// Mirroring Roslyn's `<>n__N` forwarders, this pass synthesizes a
/// private instance method on the containing class whose body is
/// `return base.M(args);` (emitted with a real `ldarg.0` receiver, so
/// it verifies) and rewrites the base call inside the state-machine body to an
/// ordinary instance call on that forwarder. The forwarder is non-async, so it
/// flows through normal class-method emit.
shared class BaseCallForwarderRewriter {
    private class Rewriter : NestedFunctionBodyRewriter {
        private let classDef StructSymbol
        private let containingFunction FunctionSymbol
        private let forwarders Dictionary[
            (Class StructSymbol, Method FunctionSymbol, ReturnType TypeSymbol),
            FunctionSymbol
        ]
        private let forwarderBodies Dictionary[FunctionSymbol, BoundBlockStatement]
        private let ordinalByClass Dictionary[StructSymbol, int32]
        private let isStateMachine bool
        private var functionLiteralDepth int32

        init(
            classDef StructSymbol,
            containingFunction FunctionSymbol,
            forwarders Dictionary[(Class StructSymbol, Method FunctionSymbol, ReturnType TypeSymbol), FunctionSymbol],
            forwarderBodies Dictionary[FunctionSymbol, BoundBlockStatement],
            ordinalByClass Dictionary[StructSymbol, int32],
            isStateMachine bool
        ) {
            this.classDef = classDef
            this.containingFunction = containingFunction
            this.forwarders = forwarders
            this.forwarderBodies = forwarderBodies
            this.ordinalByClass = ordinalByClass
            this.isStateMachine = isStateMachine
        }

        private prop ForwardsBaseCalls bool -> this.isStateMachine || this.functionLiteralDepth > 0

        /// Rewrites an initialization plan's arguments, prologue and body.
        /// @param plan The plan.
        /// @returns The rewritten plan, or [`plan`](paramref) when nothing changed.
        internal func RewritePlan(plan BoundInitializationPlan) BoundInitializationPlan -> plan.Rewrite(
            this.RewriteExpression,
            this.RewriteStatement
        )

        protected override func RewriteFunctionLiteralExpression(node BoundFunctionLiteralExpression) BoundExpression {
            this.functionLiteralDepth++
            try {
                return base.RewriteFunctionLiteralExpression(node)
            } finally {
                this.functionLiteralDepth--
            }
        }

        protected override func RewriteGoStatement(node BoundGoStatement) BoundStatement {
            // A `go` operand (and an `async let` initializer, which binds to
            // one) runs in a synthesized goroutine closure that holds `this`
            // in a field, exactly like a function literal (issue #4392).
            this.functionLiteralDepth++
            try {
                return base.RewriteGoStatement(node)
            } finally {
                this.functionLiteralDepth--
            }
        }

        protected override func RewriteBaseClassCallExpression(node BoundBaseClassCallExpression) BoundExpression {
            // Recurse into arguments first.
            let rewritten = cast[BoundBaseClassCallExpression](base.RewriteBaseClassCallExpression(node))
            if !this.ForwardsBaseCalls {
                return rewritten
            }
            // A base auto-property accessor has no accessor symbol of its own:
            // forward it through a forwarder that repeats the same accessor
            // call on its own `this`.
            if rewritten.IsPropertyAccessor {
                let accessorForwarder = this.CreateAccessorForwarder(rewritten)
                return BoundUserInstanceCallExpression(
                    rewritten.Syntax,
                    rewritten.Receiver,
                    accessorForwarder,
                    rewritten.Arguments,
                    rewritten.Type
                )
            }
            let method = Invariant.Required(
                rewritten.Method,
                "the property-accessor form returned above, so only the method form reaches here",
                expression: "rewritten.Method"
            )
            let forwarder = this.GetOrCreateForwarder(rewritten.BaseClass, method, rewritten.Type)
            return BoundUserInstanceCallExpression(
                rewritten.Syntax,
                rewritten.Receiver,
                forwarder,
                rewritten.Arguments,
                rewritten.Type
            ){MethodTypeArguments = rewritten.MethodTypeArguments}
        }

        protected override func RewriteMethodGroupExpression(node BoundMethodGroupExpression) BoundExpression {
            // `base.M` converted to a delegate loads the base method with a
            // non-virtual `ldftn`, which the verifier accepts only on the
            // calling method's own `this`. Point the delegate at the
            // forwarder, which is private and non-virtual, instead.
            let rewritten = cast[BoundMethodGroupExpression](base.RewriteMethodGroupExpression(node))
            // The forwarded group's candidate set is the forwarder alone (the
            // rebuilt node's constructor sets it); a group that is not yet
            // resolved to one candidate is left to the base rewrite. Read as a
            // plain member of `node` so the GSA0005 clone-preservation check
            // sees it in both the C# and the translated G# analyzer (a
            // `.Length` read is not recognised after translation).
            let candidates = node.Candidates
            if !rewritten.ForceNonVirtualDispatch ||
                !this.ForwardsBaseCalls ||
                rewritten.Receiver == nil ||
                rewritten.Function is not{} method ||
                rewritten.FunctionType is not{} functionType ||
                candidates.IsDefaultOrEmpty ||
                method.ReceiverType is not StructSymbol baseClass {
                return rewritten
            }
            // A generic base method's forwarder is generic in the same type
            // parameters, so the group's type arguments carry over. The
            // forwarder returns what the delegate observes (for an async
            // method, the Task the method emits), not the declared result.
            let forwarder = this.GetOrCreateForwarder(baseClass, method, functionType.ReturnType)
            return BoundMethodGroupExpression(
                rewritten.Syntax,
                rewritten.Receiver,
                forwarder,
                functionType,
                rewritten.StaticOwnerType,
                rewritten.MethodTypeArguments
            ){HasTargetDelegateType = rewritten.HasTargetDelegateType}
        }

        protected override func RewriteImportedInstanceCallExpression(
            node BoundImportedInstanceCallExpression
        ) BoundExpression {
            let rewritten = cast[BoundImportedInstanceCallExpression](base.RewriteImportedInstanceCallExpression(node))
            if !rewritten.IsNonVirtualBaseCall || !this.ForwardsBaseCalls {
                return rewritten
            }
            let forwarder = this.CreateImportedForwarder(rewritten, out var enclosingMethodTypeParameters)
            return BoundUserInstanceCallExpression(
                rewritten.Syntax,
                rewritten.Receiver,
                forwarder,
                rewritten.Arguments,
                rewritten.Type
            ){
                MethodTypeArguments = if enclosingMethodTypeParameters.IsDefaultOrEmpty {
                    default(ImmutableArray[TypeSymbol])
                } else {
                    enclosingMethodTypeParameters.CastArray[TypeSymbol]()
                }
            }
        }

        protected override func RewriteEventSubscriptionExpression(
            node BoundEventSubscriptionExpression
        ) BoundExpression {
            let rewritten = cast[BoundEventSubscriptionExpression](base.RewriteEventSubscriptionExpression(node))
            if !rewritten.IsNonVirtualBaseCall || !this.ForwardsBaseCalls || rewritten.Receiver is not{} receiver {
                return rewritten
            }
            return BoundUserInstanceCallExpression(
                rewritten.Syntax,
                receiver,
                this.CreateAccessorForwarder(rewritten),
                ImmutableArray.Create(rewritten.Handler),
                rewritten.Type
            )
        }

        protected override func RewriteClrEventSubscriptionExpression(
            node BoundClrEventSubscriptionExpression
        ) BoundExpression {
            let rewritten = cast[BoundClrEventSubscriptionExpression](base.RewriteClrEventSubscriptionExpression(node))
            if !rewritten.IsNonVirtualBaseCall || !this.ForwardsBaseCalls || rewritten.Receiver is not{} receiver {
                return rewritten
            }
            return BoundUserInstanceCallExpression(
                rewritten.Syntax,
                receiver,
                this.CreateAccessorForwarder(rewritten),
                ImmutableArray.Create(rewritten.Handler),
                rewritten.Type
            )
        }

        private func GetOrCreateForwarder(
            baseClass StructSymbol,
            method FunctionSymbol,
            returnType TypeSymbol
        ) FunctionSymbol {
            var returnType = returnType
            // The return type is part of the key: a direct call and a method
            // group of the same base method can observe different return
            // types (`() -> object = base.Name` over a `string` method, or
            // `() -> Task = base.Count` over a `Task<int32>` one). One shared
            // forwarder would hand one of them a value of the wrong type.
            // Everything else in the signature (type parameters, by-ref
            // kinds, the base class's type arguments for this derived class)
            // is fixed by the method and the forwarder's class.
            let key = (this.classDef, method, returnType)
            if this.forwarders.TryGetValue(key, out var existing) {
                return existing
            }
            this.ordinalByClass.TryGetValue(this.classDef, out var ordinal)
            this.ordinalByClass[this.classDef] = ordinal + 1
            // A generic base method gets a generic forwarder: one fresh type
            // parameter per method type parameter, with the same constraints,
            // so the forwarder's own instantiation satisfies the base method's
            // constraints and the inner call passes its type parameters
            // straight through.
            //
            // A method declared on a generic base class names that class's
            // type parameters in its signature; the forwarder lives on the
            // derived class, so they are replaced by the type arguments the
            // derived class supplies to that base (`int32` for
            // `D : Base[int32]`, `V` for `E[V] : Base[V]`).
            let substitution = Dictionary[TypeParameterSymbol, TypeSymbol]()
            this.AddBaseClassTypeArguments(method, substitution)
            let typeParameters = CloneMethodTypeParameters(method.TypeParameters, substitution)
            let Substitute = func (type TypeSymbol) TypeSymbol {
                return if substitution.Count == 0 {
                    type
                } else {
                    GSharp.Core.CodeAnalysis.Binding.Binder.SubstituteType(type, substitution)
                }
            }
            let forwarderReturnType = GetForwarderReturnType(method, returnType, Substitute)
            // Fresh parameters so the forwarder body can read them without
            // aliasing the base method's parameter symbols. A `ref`, `out` or
            // `in` parameter stays by-reference, so the forwarder passes the
            // caller's storage through instead of a copy. A suspending base
            // method's hidden context is one of them (issue #4392): the call
            // being forwarded already carries it, and the forwarder passes it
            // on.
            let paramBuilder = ImmutableArray.CreateBuilder[ParameterSymbol](method.EmittedParameters.Length)
            for p in method.EmittedParameters {
                paramBuilder.Add(ParameterSymbol(p, Substitute(p.Type), p.DeclaringSyntax))
            }
            let parameters = paramBuilder.ToImmutable()
            let forwarder = FunctionSymbol(
                "<>n__" + ordinal.ToString(),
                parameters,
                forwarderReturnType,
                declaration: nil,
                this.containingFunction.Package,
                Accessibility.Private,
                receiverType: this.classDef,
                explicitReceiverParameter: nil
            ){ReturnRefKind = method.ReturnRefKind}
            if !typeParameters.IsDefaultOrEmpty {
                forwarder.TypeParameters = typeParameters
            }
            let thisExpr = BoundVariableExpression(
                nil,
                Invariant.Required(
                    forwarder.ThisParameter,
                    "a synthesized forwarder has an instance receiver",
                    expression: "forwarder.ThisParameter"
                )
            )
            let argBuilder = ImmutableArray.CreateBuilder[BoundExpression](parameters.Length)
            for p in parameters {
                var argument BoundExpression = BoundVariableExpression(nil, p)
                if p.RefKind != RefKind.None {
                    argument = BoundAddressOfExpression(nil, argument)
                }
                argBuilder.Add(argument)
            }
            let innerCall = BoundBaseClassCallExpression(
                nil,
                thisExpr,
                baseClass,
                method,
                argBuilder.ToImmutable(),
                forwarderReturnType
            ){
                MethodTypeArguments = if typeParameters.IsDefaultOrEmpty {
                    default(ImmutableArray[TypeSymbol])
                } else {
                    typeParameters.CastArray[TypeSymbol]()
                }
            }
            returnType = forwarderReturnType
            this.forwarders[key] = forwarder
            this.forwarderBodies[forwarder] = CreateForwarderBody(forwarder, innerCall, returnType)
            return forwarder
        }

        private func CreateAccessorForwarder(node BoundExpression) FunctionSymbol {
            this.ordinalByClass.TryGetValue(this.classDef, out var ordinal)
            this.ordinalByClass[this.classDef] = ordinal + 1
            // A handler literal can have a structural function type. The
            // forwarder needs the event's declared delegate signature.
            let parameterTypes = switch node {
                case call is BoundBaseClassCallExpression:
                call.Arguments.Select((argument BoundExpression) -> argument.Type).ToImmutableArray()
                case subscription is BoundEventSubscriptionExpression:
                ImmutableArray.Create(subscription.EventType)
                case subscription is BoundClrEventSubscriptionExpression:
                ImmutableArray.Create(
                    if subscription.EventContainingType != nil {
                        MemberLookup.GetClrEventHandlerTypeSymbol(subscription.EventContainingType, subscription.Event)
                    } else {
                        MemberLookup.GetClrEventHandlerTypeSymbol(subscription.Event)
                    }
                )
                default: throw InvalidOperationException("Unsupported base accessor forwarder.")
            }
            let parameters = ImmutableArray.CreateBuilder[ParameterSymbol](parameterTypes.Length)
            for parameterType in parameterTypes {
                parameters.Add(ParameterSymbol("value", parameterType))
            }
            let parameterArray = parameters.ToImmutable()
            let forwarder = FunctionSymbol(
                "<>n__" + ordinal.ToString(),
                parameterArray,
                node.Type,
                declaration: nil,
                this.containingFunction.Package,
                Accessibility.Private,
                receiverType: this.classDef,
                explicitReceiverParameter: nil
            )
            let arguments = ImmutableArray.CreateBuilder[BoundExpression](parameterArray.Length)
            for parameter in parameterArray {
                arguments.Add(BoundVariableExpression(nil, parameter))
            }
            let receiver = BoundVariableExpression(
                nil,
                Invariant.Required(
                    forwarder.ThisParameter,
                    "a synthesized forwarder has an instance receiver",
                    expression: "forwarder.ThisParameter"
                )
            )
            let argumentArray = arguments.ToImmutable()
            let innerCall BoundExpression = switch node {
                case call is BoundBaseClassCallExpression:
                BoundBaseClassCallExpression(
                    nil,
                    receiver,
                    call.BaseClass,
                    call.Method,
                    argumentArray,
                    call.Type,
                    call.Property,
                    call.IsSetterAccessor
                )
                case subscription is BoundEventSubscriptionExpression:
                BoundEventSubscriptionExpression(
                    nil,
                    receiver,
                    subscription.StructType,
                    subscription.Event,
                    argumentArray[0],
                    subscription.IsAdd,
                    subscription.EventType
                ){IsNonVirtualBaseCall = subscription.IsNonVirtualBaseCall}
                case subscription is BoundClrEventSubscriptionExpression:
                BoundClrEventSubscriptionExpression(
                    nil,
                    receiver,
                    subscription.Event,
                    argumentArray[0],
                    subscription.IsAdd,
                    subscription.ConstrainedReceiverTypeParameter,
                    subscription.ConstrainedInterfaceType,
                    subscription.EventContainingType
                ){IsNonVirtualBaseCall = subscription.IsNonVirtualBaseCall}
                default: throw InvalidOperationException("Unsupported base accessor forwarder.")
            }
            this.forwarderBodies[forwarder] = CreateForwarderBody(forwarder, innerCall, node.Type)
            return forwarder
        }

        private func CreateImportedForwarder(
            node BoundImportedInstanceCallExpression,
            out enclosingMethodTypeParameters ImmutableArray[TypeParameterSymbol]
        ) FunctionSymbol {
            this.ordinalByClass.TryGetValue(this.classDef, out var ordinal)
            this.ordinalByClass[this.classDef] = ordinal + 1
            // A function literal inside a generic member can pass that
            // member's type parameter to the base call (`base.Echo[T](x)` in
            // `Go[T]`), so the call's types mention an MVAR of the enclosing
            // method. The forwarder is a separate method of the class, so it
            // declares its own clone of each such parameter (constraints
            // remapped) and names the clones in its signature and inner call;
            // a class type parameter is the forwarder's class's own and needs
            // nothing.
            let mentioned = List[TypeSymbol]{node.Type}
            for argument in node.Arguments {
                mentioned.Add(argument.Type)
            }
            if !node.TypeArgumentSymbols.IsDefaultOrEmpty {
                for typeArgument in node.TypeArgumentSymbols {
                    if typeArgument != nil {
                        mentioned.Add(typeArgument)
                    }
                }
            }
            enclosingMethodTypeParameters = CollectMethodTypeParameterClosure(mentioned)
            let clones = SynthesizedClosureReifier.CloneWithRemappedConstraints(
                enclosingMethodTypeParameters,
                preserveVariance: false
            )
            let substitution = Dictionary[TypeParameterSymbol, TypeSymbol]()
            for var i = 0; i < clones.Length; i++ {
                substitution[enclosingMethodTypeParameters[i]] = clones[i]
            }
            let Substitute = func (type TypeSymbol) TypeSymbol {
                return if substitution.Count == 0 {
                    type
                } else {
                    GSharp.Core.CodeAnalysis.Binding.Binder.SubstituteType(type, substitution)
                }
            }
            let returnType = Substitute(node.Type)
            let methodParameters = node.Method.GetParameters()
            let parameters = ImmutableArray.CreateBuilder[ParameterSymbol](node.Arguments.Length)
            for var i = 0; i < node.Arguments.Length; i++ {
                // A by-reference argument arrives as the address of the
                // caller's storage. The forwarder declares a `ref`/`out`/`in`
                // parameter of the pointee type and passes that address on,
                // rather than a parameter typed as the address itself.
                let argument = node.Arguments[i]
                var refKind = if node.ArgumentRefKinds.IsDefault {
                    RefKind.None
                } else {
                    node.ArgumentRefKinds[i]
                }
                var parameterType = Substitute(argument.Type)
                let clrParameter ParameterInfo? = if i < methodParameters.Length {
                    methodParameters[i]
                } else {
                    default(ParameterInfo?)
                }
                if parameterType is ByRefTypeSymbol byRef {
                    parameterType = byRef.PointeeType
                    if refKind == RefKind.None {
                        refKind = if clrParameter?.IsOut == true {
                            RefKind.Out
                        } else {
                            (
                                if clrParameter?.IsIn == true {
                                    RefKind.In
                                } else {
                                    RefKind.Ref
                                }
                            )
                        }
                    }
                }
                parameters.Add(
                    if clrParameter != nil {
                        RefCapabilities.CreateParameterSymbol(clrParameter, parameterType, "arg" + i.ToString())
                    } else {
                        ParameterSymbol("arg" + i.ToString(), parameterType, refKind: refKind)
                    }
                )
            }
            let parameterArray = parameters.ToImmutable()
            let forwarder = FunctionSymbol(
                "<>n__" + ordinal.ToString(),
                parameterArray,
                returnType,
                declaration: nil,
                this.containingFunction.Package,
                Accessibility.Private,
                receiverType: this.classDef,
                explicitReceiverParameter: nil
            ){ReturnRefKind = RefCapabilities.GetReturnRefKind(node.Method)}
            if !clones.IsDefaultOrEmpty {
                forwarder.TypeParameters = clones
            }
            var typeArgumentSymbols = node.TypeArgumentSymbols
            if substitution.Count > 0 && !typeArgumentSymbols.IsDefaultOrEmpty {
                let remapped = ImmutableArray.CreateBuilder[TypeSymbol?](typeArgumentSymbols.Length)
                for typeArgument in typeArgumentSymbols {
                    remapped.Add(
                        if typeArgument == nil {
                            default(TypeSymbol?)
                        } else {
                            Substitute(typeArgument)
                        }
                    )
                }
                typeArgumentSymbols = remapped.MoveToImmutable()
            }
            let arguments = ImmutableArray.CreateBuilder[BoundExpression](parameterArray.Length)
            for var i = 0; i < parameterArray.Length; i++ {
                let parameter = parameterArray[i]
                var argument BoundExpression = BoundVariableExpression(nil, parameter)
                if node.Arguments[i].Type is ByRefTypeSymbol {
                    argument = BoundAddressOfExpression(nil, argument)
                }
                arguments.Add(argument)
            }
            let innerCall = BoundImportedInstanceCallExpression(
                nil,
                BoundVariableExpression(
                    nil,
                    Invariant.Required(
                        forwarder.ThisParameter,
                        "a synthesized forwarder has an instance receiver",
                        expression: "forwarder.ThisParameter"
                    )
                ),
                node.Method,
                returnType,
                arguments.ToImmutable(),
                node.ArgumentRefKinds,
                typeArgumentSymbols,
                isNonVirtualBaseCall: true
            )
            this.forwarderBodies[forwarder] = CreateForwarderBody(forwarder, innerCall, returnType)
            return forwarder
        }

        /// Maps the type parameters of [`method`](paramref)'s generic
        /// declaring class to the type arguments the forwarder's class passes
        /// to that base.
        private func AddBaseClassTypeArguments(
            method FunctionSymbol,
            substitution Dictionary[TypeParameterSymbol, TypeSymbol]
        ) {
            if method.ReceiverType is not StructSymbol declaring {
                return
            }
            let declaringDefinition = declaring.Definition ?? declaring
            if declaringDefinition.TypeParameters.IsDefaultOrEmpty {
                return
            }
            let constructed StructSymbol? = this.classDef.FindConstructedGenericBase(
                (definition StructSymbol) -> object.ReferenceEquals(definition, declaringDefinition)
            )
            if constructed == nil ||
                constructed
                .TypeArguments
                .IsDefaultOrEmpty ||
                constructed
                .TypeArguments
                .Length != declaringDefinition
                .TypeParameters
                .Length {
                return
            }
            for var i = 0; i < declaringDefinition.TypeParameters.Length; i++ {
                substitution[declaringDefinition.TypeParameters[i]] = constructed.TypeArguments[i]
            }
        }

        shared {
            /// The forwarder's return type: the type the base call returns as
            /// emitted, not the G#-declared result type. An `async` method
            /// declared with no result, or with result `T`, returns
            /// `Task` or `Task<T>` (or the `ValueTask`
            /// forms), and a forwarder that returned the declared type would
            /// leave the task on the stack of a `void` method.
            /// @remarks For a non-generic method the call's own type is exactly that: the
            /// emitted return type in the derived class's terms (a generic base
            /// class's type parameters already replaced). A generic method's call
            /// type names the call's type arguments, so the forwarder instead uses
            /// the declared type in its own type parameters, re-wrapped in the
            /// call's task type when the method is async.
            private func GetForwarderReturnType(
                method FunctionSymbol,
                callType TypeSymbol,
                substitute(TypeSymbol) -> TypeSymbol
            ) TypeSymbol {
                if !method.IsGeneric {
                    return callType
                }
                let declared = substitute(method.Type)
                if !method.IsAsyncOrSuspending ||
                    (
                    declared.ClrType is {IsGenericType: true} declaredClr &&
                        callType.ClrType is {IsGenericType: true} callClr &&
                        declaredClr.GetGenericTypeDefinition() == callClr.GetGenericTypeDefinition()
                ) {
                    // Not async, or the declared type already is the emitted one
                    // (an async iterator declared as the async sequence).
                    return declared
                }
                if method.Type == TypeSymbol.Void {
                    return callType
                }
                if callType.ClrType is {IsGenericType: true} taskClr && taskClr.GetGenericArguments().Length == 1 {
                    return ImportedTypeSymbol.GetConstructed(
                        taskClr,
                        taskClr.GetGenericTypeDefinition(),
                        ImmutableArray.Create(declared)
                    )
                }
                return callType
            }

            /// The enclosing method type parameters [`mentioned`](paramref)
            /// refers to, plus every method type parameter their constraints
            /// reach, transitively (a dependent bound such as `TDerived TBase`, or
            /// a type parameter inside a class or interface constraint such as
            /// `IComparable[TBase]`), in declaration order. The forwarder clones
            /// exactly this set, so no cloned constraint is left naming an
            /// original parameter the forwarder does not declare.
            private func CollectMethodTypeParameterClosure(mentioned List[TypeSymbol]) ImmutableArray[
                TypeParameterSymbol
            ] {
                let found = List[TypeParameterSymbol]()
                let pending = Queue[TypeParameterSymbol]()
                for referenced in SynthesizedClosureReifier.CollectOrdered(mentioned) {
                    if referenced.IsMethodTypeParameter && !found.Contains(referenced) {
                        found.Add(referenced)
                        pending.Enqueue(referenced)
                    }
                }
                while pending.Count > 0 {
                    let current = pending.Dequeue()
                    let dependencies = List[TypeParameterSymbol]()
                    if current.TypeParameterBound is {} bound {
                        dependencies.Add(bound)
                    }
                    TypeSymbol.CollectReferencedTypeParameters(current.ClassConstraint, dependencies)
                    TypeSymbol.CollectReferencedTypeParameters(current.InterfaceConstraint, dependencies)
                    TypeSymbol.CollectReferencedTypeParameters(current.ClrInterfaceConstraint, dependencies)
                    for dependency in dependencies {
                        if dependency.IsMethodTypeParameter && !found.Contains(dependency) {
                            found.Add(dependency)
                            pending.Enqueue(dependency)
                        }
                    }
                }
                found.Sort((a TypeParameterSymbol, b TypeParameterSymbol) -> a.Ordinal - b.Ordinal)
                return found.ToImmutableArray()
            }

            /// Clones a generic base method's type parameters for its forwarder,
            /// carrying every constraint over and rewriting constraints that
            /// mention a sibling type parameter to the matching clone.
            private func CloneMethodTypeParameters(
                source ImmutableArray[TypeParameterSymbol],
                substitution Dictionary[TypeParameterSymbol, TypeSymbol]
            ) ImmutableArray[TypeParameterSymbol] {
                if source.IsDefaultOrEmpty {
                    return default(ImmutableArray[TypeParameterSymbol])
                }
                let clones = ImmutableArray.CreateBuilder[TypeParameterSymbol](source.Length)
                for tp in source {
                    let clone = TypeParameterSymbol(tp.Name, tp.Ordinal, tp.Constraint, tp.Variance){
                        HasReferenceTypeConstraint = tp.HasReferenceTypeConstraint,
                        HasValueTypeConstraint = tp.HasValueTypeConstraint,
                        HasDefaultConstructorConstraint = tp.HasDefaultConstructorConstraint,
                        HasUnmanagedConstraint = tp.HasUnmanagedConstraint
                    }
                    substitution[tp] = clone
                    clones.Add(clone)
                }
                for var i = 0; i < source.Length; i++ {
                    let tp = source[i]
                    let clone = clones[i]
                    clone.InterfaceConstraint = if tp.InterfaceConstraint is {} iface {
                        GSharp
                            .Core
                            .CodeAnalysis
                            .Binding
                            .Binder
                            .SubstituteType(iface, substitution) as InterfaceSymbol ??
                            iface
                    } else {
                        default(InterfaceSymbol?)
                    }
                    clone.ClrInterfaceConstraint = if tp.ClrInterfaceConstraint is {} clrIface {
                        GSharp.Core.CodeAnalysis.Binding.Binder.SubstituteType(clrIface, substitution)
                    } else {
                        default(TypeSymbol?)
                    }
                    clone.ClassConstraint = if tp.ClassConstraint is {} classConstraint {
                        GSharp.Core.CodeAnalysis.Binding.Binder.SubstituteType(classConstraint, substitution)
                    } else {
                        default(TypeSymbol?)
                    }
                    // A dependent bound (`[U T]`) follows its substitution. When the
                    // derived class closes the declaring type's `T` (`Derived :
                    // Base[Animal]`), the bound becomes the concrete type argument:
                    // an interface lands in the interface slot and anything else
                    // in the class slot, so the forwarder's metadata constraint
                    // names `Animal` rather than a `VAR(0)` the non-generic
                    // forwarder class does not have.
                    clone.TypeParameterBound = tp.TypeParameterBound
                    if tp.TypeParameterBound is {} bound && substitution.TryGetValue(bound, out var mappedBound) {
                        clone.TypeParameterBound = mappedBound as TypeParameterSymbol
                        if !(mappedBound is TypeParameterSymbol) {
                            if mappedBound is InterfaceSymbol mappedInterface {
                                clone.InterfaceConstraint ??= mappedInterface
                            } else if mappedBound.ClrType is {IsInterface: true} {
                                clone.ClrInterfaceConstraint ??= mappedBound
                            } else {
                                clone.ClassConstraint ??= mappedBound
                            }
                        }
                    }
                }
                return clones.ToImmutable()
            }

            private func CreateForwarderBody(
                forwarder FunctionSymbol,
                innerCall BoundExpression,
                type TypeSymbol?
            ) BoundBlockStatement {
                let statements = ImmutableArray.CreateBuilder[BoundStatement]()
                if type == nil || type == TypeSymbol.Void {
                    statements.Add(BoundExpressionStatement(nil, innerCall))
                    statements.Add(BoundReturnStatement(nil, nil))
                } else {
                    // A ref-returning base method's forwarder returns the same
                    // reference (`return ref base.M()`), not a copy of the value.
                    // Bound exactly like a written `return ref`: the operand is
                    // wrapped in an address-of so the emitter returns the address.
                    let isRef = forwarder.ReturnRefKind != RefKind.None
                    let returned = if isRef {
                        cast[BoundExpression](
                            BoundAddressOfExpression(
                                nil,
                                innerCall,
                                unmanaged: false,
                                isReadOnly: forwarder.ReturnRefKind == RefKind.RefReadOnly
                            )
                        )
                    } else {
                        innerCall
                    }
                    statements.Add(BoundReturnStatement(nil, returned, isRef))
                }
                return BoundBlockStatement(nil, statements.ToImmutable())
            }
        }
    }

    /// The forwarders each class currently carries from a previous run of this
    /// pass, keyed weakly on the class symbol so they live exactly as long as
    /// the compilation's bound program.
    private let AttachedForwarders ConditionalWeakTable[StructSymbol, List[FunctionSymbol]] = ConditionalWeakTable[
        StructSymbol,
        List[FunctionSymbol]
    ]()

    /// Rewrites every async / iterator function body in [`program`](paramref)
    /// so that nested `base.M(...)` method calls are routed through
    /// synthesized forwarders, returning the updated program.
    /// @param program The bound program to transform.
    /// @returns The updated program, or the original when no base call required forwarding.
    func Rewrite(program BoundProgram) BoundProgram {
        // Forwarders shared across the whole program, keyed by (containing class
        // definition, base method) so repeated base calls reuse one forwarder.
        let forwarders = Dictionary[
            (Class StructSymbol, Method FunctionSymbol, ReturnType TypeSymbol),
            FunctionSymbol
        ]()
        let forwarderBodies = Dictionary[FunctionSymbol, BoundBlockStatement]()
        let ordinalByClass = Dictionary[StructSymbol, int32]()
        let rewrittenBodies = Dictionary[FunctionSymbol, BoundBlockStatement]()
        // Issue #4663: deterministic order, never identity-hash order.
        for pair in BoundProgramOrder.Functions(program) {
            let function = pair.Key
            let body BoundBlockStatement? = pair.Value
            if body == nil {
                continue
            }
            if function.ReceiverType is not StructSymbol containingType {
                continue
            }
            // A state-machine body forwards every base call; any other
            // instance member forwards only the base calls nested in its
            // function literals, whose `this` is a captured field.
            let isStateMachine = function.IsAsyncOrSuspending || IteratorDetection.ContainsYield(body)
            let classDef = containingType.Definition ?? containingType
            let rewriter = BaseCallForwarderRewriter.Rewriter(
                classDef,
                function,
                forwarders,
                forwarderBodies,
                ordinalByClass,
                isStateMachine
            )
            let newBody = cast[BoundBlockStatement](rewriter.RewriteStatement(body))
            if !object.ReferenceEquals(newBody, body) {
                rewrittenBodies[function] = newBody
            }
        }
        // Constructors whose bodies moved into an initialization plan (the
        // InitializationPlanner runs first and takes constructors with
        // managed-reference work out of `Functions`) get the same treatment:
        // a function literal in the plan's body, prologue or base-initializer
        // arguments can call `base.M()` and needs the forwarder just as much.
        // Static plans have no `base`.
        let rewrittenPlans = Dictionary[(Owner Symbol, Static bool), BoundInitializationPlan]()
        // Issue #4663: deterministic order, never identity-hash order.
        for pair in BoundProgramOrder.Initializers(program) {
            let plan = pair.Value
            if plan.Function.ReceiverType is not StructSymbol planType {
                continue
            }
            let planClass = planType.Definition ?? planType
            let planRewriter = BaseCallForwarderRewriter.Rewriter(
                planClass,
                plan.Function,
                forwarders,
                forwarderBodies,
                ordinalByClass,
                isStateMachine: false
            )
            let rewrittenPlan = planRewriter.RewritePlan(plan)
            if !object.ReferenceEquals(rewrittenPlan, plan) {
                rewrittenPlans[pair.Key] = rewrittenPlan
            }
        }
        if forwarderBodies.Count == 0 {
            return program
        }
        // Attach forwarders to their containing class definitions.
        let methodsByClass = Dictionary[StructSymbol, ImmutableArray[FunctionSymbol].Builder]()
        for forwarder in forwarderBodies.Keys {
            let owner = Invariant.Required(
                forwarder.ReceiverType as StructSymbol,
                "a synthesized forwarder has a struct receiver",
                expression: "forwarder.ReceiverType as StructSymbol"
            )
            if !methodsByClass.TryGetValue(owner, out var builder) {
                builder = ImmutableArray.CreateBuilder[FunctionSymbol]()
                methodsByClass[owner] = builder
            }
            builder.Add(forwarder)
        }
        // The compilation caches its bound program, so a second Emit runs this
        // pass over the same class symbols. Replace the forwarders a previous
        // run attached rather than adding another set: the old ones would stay
        // in the class's method list with no body in this program.
        for entry in methodsByClass {
            let attached = entry.Value.ToImmutable()
            if AttachedForwarders.TryGetValue(entry.Key, out var previous) {
                entry.Key.RemoveMethods(previous)
                AttachedForwarders.Remove(entry.Key)
            }
            entry.Key.AddMethods(attached)
            AttachedForwarders.Add(entry.Key, List[FunctionSymbol](attached))
        }
        let functionsBuilder = program.Functions.ToBuilder()
        for entry in rewrittenBodies {
            functionsBuilder[entry.Key] = entry.Value
        }
        for entry in forwarderBodies {
            functionsBuilder[entry.Key] = entry.Value
        }
        return BoundProgram(
            program.EntryPointPackage,
            program.Packages,
            program.Diagnostics,
            functionsBuilder.ToImmutable(),
            program.EntryPoint,
            program.Statement,
            program.Structs,
            program.Interfaces,
            program.Enums,
            program.Globals,
            program.Delegates
        ){
            Initializers = if rewrittenPlans.Count == 0 {
                program.Initializers
            } else {
                program.Initializers.SetItems(rewrittenPlans)
            },
            Imports = program.Imports,
            FriendAssemblies = program.FriendAssemblies,
            AssemblyAttributes = program.AssemblyAttributes,
            ModuleAttributes = program.ModuleAttributes,
            NativeProtocols = program.NativeProtocols
        }
    }
}
