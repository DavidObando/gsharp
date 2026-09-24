// <copyright file="BaseCallForwarderRewriter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Lowering;

/// <summary>
/// Issues #1467 and #2667: routes <c>base.M(args)</c> calls that appear inside
/// async / iterator method bodies, or inside a function literal nested in any
/// instance member, through a synthesized non-virtual forwarder method on the
/// containing class.
/// </summary>
/// <remarks>
/// A base-class call lowers to a non-virtual <c>call instance R Base::M(...)</c>.
/// The CLR verifier requires the <c>this</c> argument of such a non-virtual call
/// to a (virtual) base method to be the calling method's own <c>this</c>
/// (<c>ldarg.0</c>). Inside an async / iterator state machine the original
/// <c>this</c> is hoisted into a <c>&lt;&gt;4__this</c> field, so the base call's
/// receiver is a field load — producing an ilverify <c>ThisMismatch</c> error.
/// A function literal is emitted as a method of a closure class that holds
/// the captured <c>this</c> in a field, so a base call inside it has the same
/// problem (ADR-0192 follow-on 2: a translated C# local function calling
/// <c>base.Crawlpos()</c>). Roslyn forwards those calls the same way.
/// <para>
/// Mirroring Roslyn's <c>&lt;&gt;n__N</c> forwarders, this pass synthesizes a
/// private instance method on the containing class whose body is
/// <c>return base.M(args);</c> (emitted with a real <c>ldarg.0</c> receiver, so
/// it verifies) and rewrites the base call inside the state-machine body to an
/// ordinary instance call on that forwarder. The forwarder is non-async, so it
/// flows through normal class-method emit.
/// </para>
/// </remarks>
public static class BaseCallForwarderRewriter
{
    /// <summary>
    /// Rewrites every async / iterator function body in <paramref name="program"/>
    /// so that nested <c>base.M(...)</c> method calls are routed through
    /// synthesized forwarders, returning the updated program.
    /// </summary>
    /// <param name="program">The bound program to transform.</param>
    /// <returns>The updated program, or the original when no base call required forwarding.</returns>
    public static BoundProgram Rewrite(BoundProgram program)
    {
        // Forwarders shared across the whole program, keyed by (containing class
        // definition, base method) so repeated base calls reuse one forwarder.
        var forwarders = new Dictionary<(StructSymbol Class, FunctionSymbol Method, TypeSymbol ReturnType), FunctionSymbol>();
        var forwarderBodies = new Dictionary<FunctionSymbol, BoundBlockStatement>();
        var ordinalByClass = new Dictionary<StructSymbol, int>();
        var rewrittenBodies = new Dictionary<FunctionSymbol, BoundBlockStatement>();

        foreach (var pair in program.Functions)
        {
            var function = pair.Key;
            var body = pair.Value;
            if (body == null)
            {
                continue;
            }

            if (function.ReceiverType is not StructSymbol containingType)
            {
                continue;
            }

            // A state-machine body forwards every base call; any other
            // instance member forwards only the base calls nested in its
            // function literals, whose `this` is a captured field.
            var isStateMachine = function.IsAsyncOrSuspending || IteratorDetection.ContainsYield(body);
            var classDef = containingType.Definition ?? containingType;
            var rewriter = new Rewriter(classDef, function, forwarders, forwarderBodies, ordinalByClass, isStateMachine);
            var newBody = (BoundBlockStatement)rewriter.RewriteStatement(body);
            if (!ReferenceEquals(newBody, body))
            {
                rewrittenBodies[function] = newBody;
            }
        }

        // Constructors whose bodies moved into an initialization plan (the
        // InitializationPlanner runs first and takes constructors with
        // managed-reference work out of `Functions`) get the same treatment:
        // a function literal in the plan's body, prologue or base-initializer
        // arguments can call `base.M()` and needs the forwarder just as much.
        // Static plans have no `base`.
        var rewrittenPlans = new Dictionary<(Symbol Owner, bool Static), BoundInitializationPlan>();
        foreach (var pair in program.Initializers)
        {
            var plan = pair.Value;
            if (plan.Function.ReceiverType is not StructSymbol planType)
            {
                continue;
            }

            var planClass = planType.Definition ?? planType;
            var planRewriter = new Rewriter(planClass, plan.Function, forwarders, forwarderBodies, ordinalByClass, isStateMachine: false);
            var rewrittenPlan = planRewriter.RewritePlan(plan);
            if (!ReferenceEquals(rewrittenPlan, plan))
            {
                rewrittenPlans[pair.Key] = rewrittenPlan;
            }
        }

        if (forwarderBodies.Count == 0)
        {
            return program;
        }

        // Attach forwarders to their containing class definitions.
        var methodsByClass = new Dictionary<StructSymbol, ImmutableArray<FunctionSymbol>.Builder>();
        foreach (var forwarder in forwarderBodies.Keys)
        {
            var owner = Invariant.Required(forwarder.ReceiverType as StructSymbol, "a synthesized forwarder has a struct receiver");
            if (!methodsByClass.TryGetValue(owner, out var builder))
            {
                builder = ImmutableArray.CreateBuilder<FunctionSymbol>();
                methodsByClass[owner] = builder;
            }

            builder.Add(forwarder);
        }

        foreach (var entry in methodsByClass)
        {
            entry.Key.AddMethods(entry.Value.ToImmutable());
        }

        var functionsBuilder = program.Functions.ToBuilder();
        foreach (var entry in rewrittenBodies)
        {
            functionsBuilder[entry.Key] = entry.Value;
        }

        foreach (var entry in forwarderBodies)
        {
            functionsBuilder[entry.Key] = entry.Value;
        }

        return new BoundProgram(
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
            program.Delegates)
        {
            Initializers = rewrittenPlans.Count == 0 ? program.Initializers : program.Initializers.SetItems(rewrittenPlans),
            Imports = program.Imports,
            FriendAssemblies = program.FriendAssemblies,
            AssemblyAttributes = program.AssemblyAttributes,
            ModuleAttributes = program.ModuleAttributes,
        };
    }

    private sealed class Rewriter : NestedFunctionBodyRewriter
    {
        private readonly StructSymbol classDef;
        private readonly FunctionSymbol containingFunction;
        private readonly Dictionary<(StructSymbol Class, FunctionSymbol Method, TypeSymbol ReturnType), FunctionSymbol> forwarders;
        private readonly Dictionary<FunctionSymbol, BoundBlockStatement> forwarderBodies;
        private readonly Dictionary<StructSymbol, int> ordinalByClass;
        private readonly bool isStateMachine;
        private int functionLiteralDepth;

        public Rewriter(
            StructSymbol classDef,
            FunctionSymbol containingFunction,
            Dictionary<(StructSymbol Class, FunctionSymbol Method, TypeSymbol ReturnType), FunctionSymbol> forwarders,
            Dictionary<FunctionSymbol, BoundBlockStatement> forwarderBodies,
            Dictionary<StructSymbol, int> ordinalByClass,
            bool isStateMachine)
        {
            this.classDef = classDef;
            this.containingFunction = containingFunction;
            this.forwarders = forwarders;
            this.forwarderBodies = forwarderBodies;
            this.ordinalByClass = ordinalByClass;
            this.isStateMachine = isStateMachine;
        }

        private bool ForwardsBaseCalls => this.isStateMachine || this.functionLiteralDepth > 0;

        /// <summary>Rewrites an initialization plan's arguments, prologue and body.</summary>
        /// <param name="plan">The plan.</param>
        /// <returns>The rewritten plan, or <paramref name="plan"/> when nothing changed.</returns>
        internal BoundInitializationPlan RewritePlan(BoundInitializationPlan plan)
            => plan.Rewrite(this.RewriteExpression, this.RewriteStatement);

        protected override BoundExpression RewriteFunctionLiteralExpression(BoundFunctionLiteralExpression node)
        {
            this.functionLiteralDepth++;
            try
            {
                return base.RewriteFunctionLiteralExpression(node);
            }
            finally
            {
                this.functionLiteralDepth--;
            }
        }

        protected override BoundExpression RewriteBaseClassCallExpression(BoundBaseClassCallExpression node)
        {
            // Recurse into arguments first.
            var rewritten = (BoundBaseClassCallExpression)base.RewriteBaseClassCallExpression(node);
            if (!this.ForwardsBaseCalls)
            {
                return rewritten;
            }

            // A base auto-property accessor has no accessor symbol of its own:
            // forward it through a forwarder that repeats the same accessor
            // call on its own `this`.
            if (rewritten.IsPropertyAccessor)
            {
                var accessorForwarder = this.CreatePropertyAccessorForwarder(rewritten);
                return new BoundUserInstanceCallExpression(
                    rewritten.Syntax,
                    rewritten.Receiver,
                    accessorForwarder,
                    rewritten.Arguments,
                    rewritten.Type);
            }

            var method = Invariant.Required(
                rewritten.Method,
                "the property-accessor form returned above, so only the method form reaches here");
            var forwarder = this.GetOrCreateForwarder(rewritten.BaseClass, method, rewritten.Type);
            return new BoundUserInstanceCallExpression(
                rewritten.Syntax,
                rewritten.Receiver,
                forwarder,
                rewritten.Arguments,
                rewritten.Type)
            {
                // A generic forwarder mirrors the base method's type
                // parameters one for one, so the call's type arguments carry
                // over unchanged.
                MethodTypeArguments = rewritten.MethodTypeArguments,
            };
        }

        protected override BoundExpression RewriteMethodGroupExpression(BoundMethodGroupExpression node)
        {
            // `base.M` converted to a delegate loads the base method with a
            // non-virtual `ldftn`, which the verifier accepts only on the
            // calling method's own `this`. Point the delegate at the
            // forwarder, which is private and non-virtual, instead.
            var rewritten = (BoundMethodGroupExpression)base.RewriteMethodGroupExpression(node);
            if (!rewritten.ForceNonVirtualDispatch
                || !this.ForwardsBaseCalls
                || rewritten.Receiver == null
                || rewritten.Function is not { } method
                || rewritten.FunctionType is not { } functionType
                || rewritten.Candidates.Length != 1
                || method.ReceiverType is not StructSymbol baseClass)
            {
                return rewritten;
            }

            // A generic base method's forwarder is generic in the same type
            // parameters, so the group's type arguments carry over. The
            // forwarder returns what the delegate observes (for an async
            // method, the Task the method emits), not the declared result.
            var forwarder = this.GetOrCreateForwarder(baseClass, method, functionType.ReturnType);
            return new BoundMethodGroupExpression(
                rewritten.Syntax,
                rewritten.Receiver,
                forwarder,
                functionType,
                rewritten.StaticOwnerType,
                rewritten.MethodTypeArguments)
            {
                HasTargetDelegateType = rewritten.HasTargetDelegateType,
            };
        }

        protected override BoundExpression RewriteImportedInstanceCallExpression(BoundImportedInstanceCallExpression node)
        {
            var rewritten = (BoundImportedInstanceCallExpression)base.RewriteImportedInstanceCallExpression(node);
            if (!rewritten.IsNonVirtualBaseCall || !this.ForwardsBaseCalls)
            {
                return rewritten;
            }

            var forwarder = this.CreateImportedForwarder(rewritten, out var enclosingMethodTypeParameters);
            return new BoundUserInstanceCallExpression(
                rewritten.Syntax,
                rewritten.Receiver,
                forwarder,
                rewritten.Arguments,
                rewritten.Type)
            {
                // The forwarder is generic in the enclosing method's type
                // parameters the call mentions; the caller instantiates it
                // with those same parameters, which flow in from the closure.
                MethodTypeArguments = enclosingMethodTypeParameters.IsDefaultOrEmpty
                    ? default
                    : enclosingMethodTypeParameters.CastArray<TypeSymbol>(),
            };
        }

        private FunctionSymbol GetOrCreateForwarder(StructSymbol baseClass, FunctionSymbol method, TypeSymbol returnType)
        {
            // The return type is part of the key: a direct call and a method
            // group of the same base method can observe different return
            // types (`() -> object = base.Name` over a `string` method, or
            // `() -> Task = base.Count` over a `Task<int32>` one). One shared
            // forwarder would hand one of them a value of the wrong type.
            // Everything else in the signature (type parameters, by-ref
            // kinds, the base class's type arguments for this derived class)
            // is fixed by the method and the forwarder's class.
            var key = (this.classDef, method, returnType);
            if (this.forwarders.TryGetValue(key, out var existing))
            {
                return existing;
            }

            this.ordinalByClass.TryGetValue(this.classDef, out var ordinal);
            this.ordinalByClass[this.classDef] = ordinal + 1;

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
            var substitution = new Dictionary<TypeParameterSymbol, TypeSymbol>();
            this.AddBaseClassTypeArguments(method, substitution);
            var typeParameters = CloneMethodTypeParameters(method.TypeParameters, substitution);
            TypeSymbol Substitute(TypeSymbol type) =>
                substitution.Count == 0 ? type : Binder.SubstituteType(type, substitution);
            var forwarderReturnType = GetForwarderReturnType(method, returnType, Substitute);

            // Fresh parameters so the forwarder body can read them without
            // aliasing the base method's parameter symbols. A `ref`, `out` or
            // `in` parameter stays by-reference, so the forwarder passes the
            // caller's storage through instead of a copy.
            var paramBuilder = ImmutableArray.CreateBuilder<ParameterSymbol>(method.Parameters.Length);
            foreach (var p in method.Parameters)
            {
                paramBuilder.Add(new ParameterSymbol(p.Name, Substitute(p.Type), refKind: p.RefKind));
            }

            var parameters = paramBuilder.ToImmutable();
            var forwarder = new FunctionSymbol(
                "<>n__" + ordinal,
                parameters,
                forwarderReturnType,
                declaration: null,
                this.containingFunction.Package,
                Accessibility.Private,
                receiverType: this.classDef,
                explicitReceiverParameter: null)
            {
                ReturnRefKind = method.ReturnRefKind,
            };
            if (!typeParameters.IsDefaultOrEmpty)
            {
                forwarder.TypeParameters = typeParameters;
            }

            var thisExpr = new BoundVariableExpression(null, Invariant.Required(forwarder.ThisParameter, "a synthesized forwarder has an instance receiver"));
            var argBuilder = ImmutableArray.CreateBuilder<BoundExpression>(parameters.Length);
            foreach (var p in parameters)
            {
                BoundExpression argument = new BoundVariableExpression(null, p);
                if (p.RefKind != RefKind.None)
                {
                    argument = new BoundAddressOfExpression(null, argument);
                }

                argBuilder.Add(argument);
            }

            var innerCall = new BoundBaseClassCallExpression(
                null,
                thisExpr,
                baseClass,
                method,
                argBuilder.ToImmutable(),
                forwarderReturnType)
            {
                MethodTypeArguments = typeParameters.IsDefaultOrEmpty
                    ? default
                    : typeParameters.CastArray<TypeSymbol>(),
            };
            returnType = forwarderReturnType;

            this.forwarders[key] = forwarder;
            this.forwarderBodies[forwarder] = CreateForwarderBody(forwarder, innerCall, returnType);
            return forwarder;
        }

        private FunctionSymbol CreatePropertyAccessorForwarder(BoundBaseClassCallExpression node)
        {
            this.ordinalByClass.TryGetValue(this.classDef, out var ordinal);
            this.ordinalByClass[this.classDef] = ordinal + 1;

            var parameters = ImmutableArray.CreateBuilder<ParameterSymbol>(node.Arguments.Length);
            foreach (var argument in node.Arguments)
            {
                parameters.Add(new ParameterSymbol("value", argument.Type));
            }

            var parameterArray = parameters.ToImmutable();
            var forwarder = new FunctionSymbol(
                "<>n__" + ordinal,
                parameterArray,
                node.Type,
                declaration: null,
                this.containingFunction.Package,
                Accessibility.Private,
                receiverType: this.classDef,
                explicitReceiverParameter: null);

            var arguments = ImmutableArray.CreateBuilder<BoundExpression>(parameterArray.Length);
            foreach (var parameter in parameterArray)
            {
                arguments.Add(new BoundVariableExpression(null, parameter));
            }

            var innerCall = new BoundBaseClassCallExpression(
                null,
                new BoundVariableExpression(null, Invariant.Required(forwarder.ThisParameter, "a synthesized forwarder has an instance receiver")),
                node.BaseClass,
                node.Method,
                arguments.ToImmutable(),
                node.Type,
                node.Property,
                node.IsSetterAccessor);

            this.forwarderBodies[forwarder] = CreateForwarderBody(forwarder, innerCall, node.Type);
            return forwarder;
        }

        private FunctionSymbol CreateImportedForwarder(
            BoundImportedInstanceCallExpression node,
            out ImmutableArray<TypeParameterSymbol> enclosingMethodTypeParameters)
        {
            this.ordinalByClass.TryGetValue(this.classDef, out var ordinal);
            this.ordinalByClass[this.classDef] = ordinal + 1;

            // A function literal inside a generic member can pass that
            // member's type parameter to the base call (`base.Echo[T](x)` in
            // `Go[T]`), so the call's types mention an MVAR of the enclosing
            // method. The forwarder is a separate method of the class, so it
            // declares its own clone of each such parameter (constraints
            // remapped) and names the clones in its signature and inner call;
            // a class type parameter is the forwarder's class's own and needs
            // nothing.
            var mentioned = new List<TypeSymbol> { node.Type };
            foreach (var argument in node.Arguments)
            {
                mentioned.Add(argument.Type);
            }

            if (!node.TypeArgumentSymbols.IsDefaultOrEmpty)
            {
                foreach (var typeArgument in node.TypeArgumentSymbols)
                {
                    if (typeArgument != null)
                    {
                        mentioned.Add(typeArgument);
                    }
                }
            }

            var methodTypeParameters = ImmutableArray.CreateBuilder<TypeParameterSymbol>();
            foreach (var referenced in SynthesizedClosureReifier.CollectOrdered(mentioned))
            {
                if (referenced.IsMethodTypeParameter)
                {
                    methodTypeParameters.Add(referenced);
                }
            }

            enclosingMethodTypeParameters = methodTypeParameters.ToImmutable();
            var clones = SynthesizedClosureReifier.CloneWithRemappedConstraints(enclosingMethodTypeParameters, preserveVariance: false);
            var substitution = new Dictionary<TypeParameterSymbol, TypeSymbol>();
            for (var i = 0; i < clones.Length; i++)
            {
                substitution[enclosingMethodTypeParameters[i]] = clones[i];
            }

            TypeSymbol Substitute(TypeSymbol type) =>
                substitution.Count == 0 ? type : Binder.SubstituteType(type, substitution);
            var returnType = Substitute(node.Type);

            var methodParameters = node.Method.GetParameters();
            var parameters = ImmutableArray.CreateBuilder<ParameterSymbol>(node.Arguments.Length);
            for (var i = 0; i < node.Arguments.Length; i++)
            {
                // A by-reference argument arrives as the address of the
                // caller's storage. The forwarder declares a `ref`/`out`/`in`
                // parameter of the pointee type and passes that address on,
                // rather than a parameter typed as the address itself.
                var argument = node.Arguments[i];
                var refKind = node.ArgumentRefKinds.IsDefault ? RefKind.None : node.ArgumentRefKinds[i];
                var parameterType = Substitute(argument.Type);
                var clrParameter = i < methodParameters.Length ? methodParameters[i] : null;
                if (parameterType is ByRefTypeSymbol byRef)
                {
                    parameterType = byRef.PointeeType;
                    if (refKind == RefKind.None)
                    {
                        refKind = clrParameter?.IsOut == true
                            ? RefKind.Out
                            : clrParameter?.IsIn == true ? RefKind.In : RefKind.Ref;
                    }
                }

                parameters.Add(new ParameterSymbol(
                    clrParameter?.Name ?? "arg" + i,
                    parameterType,
                    refKind: refKind));
            }

            var parameterArray = parameters.ToImmutable();
            var forwarder = new FunctionSymbol(
                "<>n__" + ordinal,
                parameterArray,
                returnType,
                declaration: null,
                this.containingFunction.Package,
                Accessibility.Private,
                receiverType: this.classDef,
                explicitReceiverParameter: null)
            {
                ReturnRefKind = RefCapabilities.GetReturnRefKind(node.Method),
            };
            if (!clones.IsDefaultOrEmpty)
            {
                forwarder.TypeParameters = clones;
            }

            var typeArgumentSymbols = node.TypeArgumentSymbols;
            if (substitution.Count > 0 && !typeArgumentSymbols.IsDefaultOrEmpty)
            {
                var remapped = ImmutableArray.CreateBuilder<TypeSymbol?>(typeArgumentSymbols.Length);
                foreach (var typeArgument in typeArgumentSymbols)
                {
                    remapped.Add(typeArgument == null ? null : Substitute(typeArgument));
                }

                typeArgumentSymbols = remapped.MoveToImmutable();
            }

            var arguments = ImmutableArray.CreateBuilder<BoundExpression>(parameterArray.Length);
            for (var i = 0; i < parameterArray.Length; i++)
            {
                var parameter = parameterArray[i];
                BoundExpression argument = new BoundVariableExpression(null, parameter);
                if (node.Arguments[i].Type is ByRefTypeSymbol)
                {
                    argument = new BoundAddressOfExpression(null, argument);
                }

                arguments.Add(argument);
            }

            var innerCall = new BoundImportedInstanceCallExpression(
                null,
                new BoundVariableExpression(null, Invariant.Required(forwarder.ThisParameter, "a synthesized forwarder has an instance receiver")),
                node.Method,
                returnType,
                arguments.ToImmutable(),
                node.ArgumentRefKinds,
                typeArgumentSymbols,
                isNonVirtualBaseCall: true);

            this.forwarderBodies[forwarder] = CreateForwarderBody(forwarder, innerCall, returnType);
            return forwarder;
        }

        /// <summary>
        /// The forwarder's return type: the type the base call returns as
        /// emitted, not the G#-declared result type. An <c>async</c> method
        /// declared with no result, or with result <c>T</c>, returns
        /// <c>Task</c> or <c>Task&lt;T&gt;</c> (or the <c>ValueTask</c>
        /// forms), and a forwarder that returned the declared type would
        /// leave the task on the stack of a <c>void</c> method.
        /// </summary>
        /// <remarks>
        /// For a non-generic method the call's own type is exactly that: the
        /// emitted return type in the derived class's terms (a generic base
        /// class's type parameters already replaced). A generic method's call
        /// type names the call's type arguments, so the forwarder instead uses
        /// the declared type in its own type parameters, re-wrapped in the
        /// call's task type when the method is async.
        /// </remarks>
        private static TypeSymbol GetForwarderReturnType(
            FunctionSymbol method,
            TypeSymbol callType,
            System.Func<TypeSymbol, TypeSymbol> substitute)
        {
            if (!method.IsGeneric)
            {
                return callType;
            }

            var declared = substitute(method.Type);
            if (!method.IsAsyncOrSuspending
                || (declared.ClrType is { IsGenericType: true } declaredClr
                    && callType.ClrType is { IsGenericType: true } callClr
                    && declaredClr.GetGenericTypeDefinition() == callClr.GetGenericTypeDefinition()))
            {
                // Not async, or the declared type already is the emitted one
                // (an async iterator declared as the async sequence).
                return declared;
            }

            if (method.Type == TypeSymbol.Void)
            {
                return callType;
            }

            if (callType.ClrType is { IsGenericType: true } taskClr
                && taskClr.GetGenericArguments().Length == 1)
            {
                return ImportedTypeSymbol.GetConstructed(
                    taskClr,
                    taskClr.GetGenericTypeDefinition(),
                    ImmutableArray.Create(declared));
            }

            return callType;
        }

        /// <summary>
        /// Maps the type parameters of <paramref name="method"/>'s generic
        /// declaring class to the type arguments the forwarder's class passes
        /// to that base.
        /// </summary>
        private void AddBaseClassTypeArguments(FunctionSymbol method, Dictionary<TypeParameterSymbol, TypeSymbol> substitution)
        {
            if (method.ReceiverType is not StructSymbol declaring)
            {
                return;
            }

            var declaringDefinition = declaring.Definition ?? declaring;
            if (declaringDefinition.TypeParameters.IsDefaultOrEmpty)
            {
                return;
            }

            var constructed = this.classDef.FindConstructedGenericBase(
                definition => ReferenceEquals(definition, declaringDefinition));
            if (constructed == null
                || constructed.TypeArguments.IsDefaultOrEmpty
                || constructed.TypeArguments.Length != declaringDefinition.TypeParameters.Length)
            {
                return;
            }

            for (var i = 0; i < declaringDefinition.TypeParameters.Length; i++)
            {
                substitution[declaringDefinition.TypeParameters[i]] = constructed.TypeArguments[i];
            }
        }

        /// <summary>
        /// Clones a generic base method's type parameters for its forwarder,
        /// carrying every constraint over and rewriting constraints that
        /// mention a sibling type parameter to the matching clone.
        /// </summary>
        private static ImmutableArray<TypeParameterSymbol> CloneMethodTypeParameters(
            ImmutableArray<TypeParameterSymbol> source,
            Dictionary<TypeParameterSymbol, TypeSymbol> substitution)
        {
            if (source.IsDefaultOrEmpty)
            {
                return default;
            }

            var clones = ImmutableArray.CreateBuilder<TypeParameterSymbol>(source.Length);
            foreach (var tp in source)
            {
                var clone = new TypeParameterSymbol(tp.Name, tp.Ordinal, tp.Constraint, tp.Variance)
                {
                    HasReferenceTypeConstraint = tp.HasReferenceTypeConstraint,
                    HasValueTypeConstraint = tp.HasValueTypeConstraint,
                    HasDefaultConstructorConstraint = tp.HasDefaultConstructorConstraint,
                    HasUnmanagedConstraint = tp.HasUnmanagedConstraint,
                };
                substitution[tp] = clone;
                clones.Add(clone);
            }

            for (var i = 0; i < source.Length; i++)
            {
                var tp = source[i];
                var clone = clones[i];
                clone.InterfaceConstraint = tp.InterfaceConstraint is { } iface
                    ? Binder.SubstituteType(iface, substitution) as InterfaceSymbol ?? iface
                    : null;
                clone.ClrInterfaceConstraint = tp.ClrInterfaceConstraint is { } clrIface
                    ? Binder.SubstituteType(clrIface, substitution)
                    : null;
                clone.ClassConstraint = tp.ClassConstraint is { } classConstraint
                    ? Binder.SubstituteType(classConstraint, substitution)
                    : null;

                // A dependent bound (`[U T]`) follows its substitution. When the
                // derived class closes the declaring type's `T` (`Derived :
                // Base[Animal]`), the bound becomes the concrete type argument:
                // an interface lands in the interface slot and anything else
                // in the class slot, so the forwarder's metadata constraint
                // names `Animal` rather than a `VAR(0)` the non-generic
                // forwarder class does not have.
                clone.TypeParameterBound = tp.TypeParameterBound;
                if (tp.TypeParameterBound is { } bound
                    && substitution.TryGetValue(bound, out var mappedBound))
                {
                    clone.TypeParameterBound = mappedBound as TypeParameterSymbol;
                    if (mappedBound is not TypeParameterSymbol)
                    {
                        if (mappedBound is InterfaceSymbol mappedInterface)
                        {
                            clone.InterfaceConstraint ??= mappedInterface;
                        }
                        else if (mappedBound.ClrType is { IsInterface: true })
                        {
                            clone.ClrInterfaceConstraint ??= mappedBound;
                        }
                        else
                        {
                            clone.ClassConstraint ??= mappedBound;
                        }
                    }
                }
            }

            return clones.ToImmutable();
        }

        private static BoundBlockStatement CreateForwarderBody(FunctionSymbol forwarder, BoundExpression innerCall, TypeSymbol? type)
        {
            var statements = ImmutableArray.CreateBuilder<BoundStatement>();
            if (type == null || type == TypeSymbol.Void)
            {
                statements.Add(new BoundExpressionStatement(null, innerCall));
                statements.Add(new BoundReturnStatement(null, null));
            }
            else
            {
                // A ref-returning base method's forwarder returns the same
                // reference (`return ref base.M()`), not a copy of the value.
                // Bound exactly like a written `return ref`: the operand is
                // wrapped in an address-of so the emitter returns the address.
                var isRef = forwarder.ReturnRefKind != RefKind.None;
                var returned = isRef
                    ? new BoundAddressOfExpression(null, innerCall, unmanaged: false, isReadOnly: forwarder.ReturnRefKind == RefKind.RefReadOnly)
                    : innerCall;
                statements.Add(new BoundReturnStatement(null, returned, isRef));
            }

            return new BoundBlockStatement(null, statements.ToImmutable());
        }
    }
}
