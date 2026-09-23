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
        var forwarders = new Dictionary<(StructSymbol Class, FunctionSymbol Method), FunctionSymbol>();
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
            Initializers = program.Initializers,
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
        private readonly Dictionary<(StructSymbol Class, FunctionSymbol Method), FunctionSymbol> forwarders;
        private readonly Dictionary<FunctionSymbol, BoundBlockStatement> forwarderBodies;
        private readonly Dictionary<StructSymbol, int> ordinalByClass;
        private readonly bool isStateMachine;
        private int functionLiteralDepth;

        public Rewriter(
            StructSymbol classDef,
            FunctionSymbol containingFunction,
            Dictionary<(StructSymbol Class, FunctionSymbol Method), FunctionSymbol> forwarders,
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
                rewritten.Type);
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
                || !rewritten.MethodTypeArguments.IsDefaultOrEmpty
                || method.IsGeneric
                || method.ReceiverType is not StructSymbol baseClass)
            {
                return rewritten;
            }

            var forwarder = this.GetOrCreateForwarder(baseClass, method, method.Type);
            return new BoundMethodGroupExpression(
                rewritten.Syntax,
                rewritten.Receiver,
                forwarder,
                functionType,
                rewritten.StaticOwnerType)
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

            var forwarder = this.CreateImportedForwarder(rewritten);
            return new BoundUserInstanceCallExpression(
                rewritten.Syntax,
                rewritten.Receiver,
                forwarder,
                rewritten.Arguments,
                rewritten.Type);
        }

        private FunctionSymbol GetOrCreateForwarder(StructSymbol baseClass, FunctionSymbol method, TypeSymbol returnType)
        {
            var key = (this.classDef, method);
            if (this.forwarders.TryGetValue(key, out var existing))
            {
                return existing;
            }

            this.ordinalByClass.TryGetValue(this.classDef, out var ordinal);
            this.ordinalByClass[this.classDef] = ordinal + 1;

            // Fresh parameters so the forwarder body can read them without
            // aliasing the base method's parameter symbols.
            var paramBuilder = ImmutableArray.CreateBuilder<ParameterSymbol>(method.Parameters.Length);
            foreach (var p in method.Parameters)
            {
                paramBuilder.Add(new ParameterSymbol(p.Name, p.Type));
            }

            var parameters = paramBuilder.ToImmutable();
            var forwarder = new FunctionSymbol(
                "<>n__" + ordinal,
                parameters,
                returnType,
                declaration: null,
                this.containingFunction.Package,
                Accessibility.Private,
                receiverType: this.classDef,
                explicitReceiverParameter: null);

            var thisExpr = new BoundVariableExpression(null, Invariant.Required(forwarder.ThisParameter, "a synthesized forwarder has an instance receiver"));
            var argBuilder = ImmutableArray.CreateBuilder<BoundExpression>(parameters.Length);
            foreach (var p in parameters)
            {
                argBuilder.Add(new BoundVariableExpression(null, p));
            }

            var innerCall = new BoundBaseClassCallExpression(
                null,
                thisExpr,
                baseClass,
                method,
                argBuilder.ToImmutable(),
                returnType);

            this.forwarders[key] = forwarder;
            this.forwarderBodies[forwarder] = CreateForwarderBody(innerCall, returnType);
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

            this.forwarderBodies[forwarder] = CreateForwarderBody(innerCall, node.Type);
            return forwarder;
        }

        private FunctionSymbol CreateImportedForwarder(BoundImportedInstanceCallExpression node)
        {
            this.ordinalByClass.TryGetValue(this.classDef, out var ordinal);
            this.ordinalByClass[this.classDef] = ordinal + 1;

            var methodParameters = node.Method.GetParameters();
            var parameters = ImmutableArray.CreateBuilder<ParameterSymbol>(node.Arguments.Length);
            for (var i = 0; i < node.Arguments.Length; i++)
            {
                var refKind = node.ArgumentRefKinds.IsDefault ? RefKind.None : node.ArgumentRefKinds[i];
                parameters.Add(new ParameterSymbol(
                    i < methodParameters.Length ? methodParameters[i].Name ?? "arg" + i : "arg" + i,
                    node.Arguments[i].Type,
                    refKind: refKind));
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
                explicitReceiverParameter: null)
            {
                ReturnRefKind = RefCapabilities.GetReturnRefKind(node.Method),
            };

            var arguments = ImmutableArray.CreateBuilder<BoundExpression>(parameterArray.Length);
            foreach (var parameter in parameterArray)
            {
                arguments.Add(new BoundVariableExpression(null, parameter));
            }

            var innerCall = new BoundImportedInstanceCallExpression(
                null,
                new BoundVariableExpression(null, Invariant.Required(forwarder.ThisParameter, "a synthesized forwarder has an instance receiver")),
                node.Method,
                node.Type,
                arguments.ToImmutable(),
                node.ArgumentRefKinds,
                node.TypeArgumentSymbols,
                isNonVirtualBaseCall: true);

            this.forwarderBodies[forwarder] = CreateForwarderBody(innerCall, node.Type);
            return forwarder;
        }

        private static BoundBlockStatement CreateForwarderBody(BoundExpression innerCall, TypeSymbol? type)
        {
            var statements = ImmutableArray.CreateBuilder<BoundStatement>();
            if (type == null || type == TypeSymbol.Void)
            {
                statements.Add(new BoundExpressionStatement(null, innerCall));
                statements.Add(new BoundReturnStatement(null, null));
            }
            else
            {
                statements.Add(new BoundReturnStatement(null, innerCall));
            }

            return new BoundBlockStatement(null, statements.ToImmutable());
        }
    }
}
