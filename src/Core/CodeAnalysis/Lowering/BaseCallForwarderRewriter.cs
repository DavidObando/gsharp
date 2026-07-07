// <copyright file="BaseCallForwarderRewriter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Lowering;

/// <summary>
/// Issue #1467: routes <c>base.M(args)</c> calls that appear inside async /
/// iterator method bodies through a synthesized non-virtual forwarder method on
/// the containing class.
/// </summary>
/// <remarks>
/// A base-class call lowers to a non-virtual <c>call instance R Base::M(...)</c>.
/// The CLR verifier requires the <c>this</c> argument of such a non-virtual call
/// to a (virtual) base method to be the calling method's own <c>this</c>
/// (<c>ldarg.0</c>). Inside an async / iterator state machine the original
/// <c>this</c> is hoisted into a <c>&lt;&gt;4__this</c> field, so the base call's
/// receiver is a field load — producing an ilverify <c>ThisMismatch</c> error.
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
        if (program == null)
        {
            return null;
        }

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

            var isStateMachine = function.IsAsync || ContainsYield(body);
            if (!isStateMachine)
            {
                continue;
            }

            var classDef = containingType.Definition ?? containingType;
            var rewriter = new Rewriter(classDef, function, forwarders, forwarderBodies, ordinalByClass);
            var newBody = (BoundBlockStatement)rewriter.RewriteStatement(body);
            if (!ReferenceEquals(newBody, body))
            {
                rewrittenBodies[function] = newBody;
            }
        }

        if (forwarders.Count == 0)
        {
            return program;
        }

        // Attach forwarders to their containing class definitions.
        var methodsByClass = new Dictionary<StructSymbol, ImmutableArray<FunctionSymbol>.Builder>();
        foreach (var entry in forwarders)
        {
            if (!methodsByClass.TryGetValue(entry.Key.Class, out var builder))
            {
                builder = ImmutableArray.CreateBuilder<FunctionSymbol>();
                methodsByClass[entry.Key.Class] = builder;
            }

            builder.Add(entry.Value);
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
            Imports = program.Imports,
            FriendAssemblies = program.FriendAssemblies,
            AssemblyAttributes = program.AssemblyAttributes,
        };
    }

    private static bool ContainsYield(BoundStatement statement)
    {
        var walker = new YieldWalker();
        walker.Visit(statement);
        return walker.Found;
    }

    private sealed class YieldWalker : BoundTreeRewriter
    {
        public bool Found { get; private set; }

        public void Visit(BoundStatement statement) => this.RewriteStatement(statement);

        protected override BoundStatement RewriteYieldStatement(BoundYieldStatement node)
        {
            this.Found = true;
            return node;
        }
    }

    private sealed class Rewriter : BoundTreeRewriter
    {
        private readonly StructSymbol classDef;
        private readonly FunctionSymbol containingFunction;
        private readonly Dictionary<(StructSymbol Class, FunctionSymbol Method), FunctionSymbol> forwarders;
        private readonly Dictionary<FunctionSymbol, BoundBlockStatement> forwarderBodies;
        private readonly Dictionary<StructSymbol, int> ordinalByClass;

        public Rewriter(
            StructSymbol classDef,
            FunctionSymbol containingFunction,
            Dictionary<(StructSymbol Class, FunctionSymbol Method), FunctionSymbol> forwarders,
            Dictionary<FunctionSymbol, BoundBlockStatement> forwarderBodies,
            Dictionary<StructSymbol, int> ordinalByClass)
        {
            this.classDef = classDef;
            this.containingFunction = containingFunction;
            this.forwarders = forwarders;
            this.forwarderBodies = forwarderBodies;
            this.ordinalByClass = ordinalByClass;
        }

        protected override BoundExpression RewriteBaseClassCallExpression(BoundBaseClassCallExpression node)
        {
            // Property base-accessors and computed-property bridges are left
            // unchanged — only ordinary method base calls are forwarded.
            if (node.Method == null || node.Property != null)
            {
                return base.RewriteBaseClassCallExpression(node);
            }

            // Recurse into arguments first.
            var rewritten = (BoundBaseClassCallExpression)base.RewriteBaseClassCallExpression(node);

            var forwarder = this.GetOrCreateForwarder(rewritten);
            return new BoundUserInstanceCallExpression(
                rewritten.Syntax,
                rewritten.Receiver,
                forwarder,
                rewritten.Arguments,
                rewritten.Type);
        }

        private FunctionSymbol GetOrCreateForwarder(BoundBaseClassCallExpression node)
        {
            var key = (this.classDef, node.Method);
            if (this.forwarders.TryGetValue(key, out var existing))
            {
                return existing;
            }

            this.ordinalByClass.TryGetValue(this.classDef, out var ordinal);
            this.ordinalByClass[this.classDef] = ordinal + 1;

            // Fresh parameters so the forwarder body can read them without
            // aliasing the base method's parameter symbols.
            var paramBuilder = ImmutableArray.CreateBuilder<ParameterSymbol>(node.Method.Parameters.Length);
            foreach (var p in node.Method.Parameters)
            {
                paramBuilder.Add(new ParameterSymbol(p.Name, p.Type));
            }

            var parameters = paramBuilder.ToImmutable();
            var forwarder = new FunctionSymbol(
                "<>n__" + ordinal,
                parameters,
                node.Type,
                declaration: null,
                this.containingFunction.Package,
                Accessibility.Private,
                receiverType: this.classDef,
                explicitReceiverParameter: null);

            var thisExpr = new BoundVariableExpression(null, forwarder.ThisParameter);
            var argBuilder = ImmutableArray.CreateBuilder<BoundExpression>(parameters.Length);
            foreach (var p in parameters)
            {
                argBuilder.Add(new BoundVariableExpression(null, p));
            }

            var innerCall = new BoundBaseClassCallExpression(
                null,
                thisExpr,
                node.BaseClass,
                node.Method,
                argBuilder.ToImmutable(),
                node.Type);

            var statements = ImmutableArray.CreateBuilder<BoundStatement>();
            if (node.Type == null || node.Type == TypeSymbol.Void)
            {
                statements.Add(new BoundExpressionStatement(null, innerCall));
                statements.Add(new BoundReturnStatement(null, null));
            }
            else
            {
                statements.Add(new BoundReturnStatement(null, innerCall));
            }

            this.forwarders[key] = forwarder;
            this.forwarderBodies[forwarder] = new BoundBlockStatement(null, statements.ToImmutable());
            return forwarder;
        }
    }
}
