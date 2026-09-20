// <copyright file="ManagedReferencePhaseTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using Gsharp.Values;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Compiler.Tests;

public sealed class ManagedReferencePhaseTests
{
    [Fact]
    public void PersistentAddressesAreLoweredBeforeEmissionIncludingNestedBodiesAndInitializers()
    {
        const string source = """
            package ManagedPhases
            class Box { var Value int32 }
            class Holder { var Reference managed[int32] = managed(Box{Value: 1}.Value) }
            func Make() managed[int32] {
                var value = 1
                let nested = func () managed[int32] { return managed(value) }
                return nested()
            }
            """;
        using var references = ReferenceResolver.WithRuntimeReferences(new[] { typeof(ManagedRef<>).Assembly.Location });
        var compilation = new Compilation(references, SyntaxTree.Parse(source)) { IsLibrary = true };
        var bound = compilation.BoundProgram;
        Assert.Empty(bound.Diagnostics.Where(d => d.IsError));
        var before = new NodeCounter();
        before.VisitProgram(bound);
        Assert.Equal(2, before.PersistentAddresses);
        Assert.Equal(0, before.FieldKeys);

        var boxed = CaptureBoxingRewriter.Lower(bound, references.MapClrTypeToReferences);
        var lowered = ManagedReferenceLowerer.Lower(boxed, references);
        var after = new NodeCounter();
        after.VisitProgram(lowered);

        Assert.Equal(0, after.PersistentAddresses);
        Assert.True(after.FieldKeys >= 2);
        Assert.Contains(lowered.Structs, type => type.Methods.Any(method => method.Name == "Borrow"));
    }

    [Fact]
    public void LocationBlockEarlyReturnPreservesBorrowAndPersistentIdentity()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile(
            """
            package ManagedLocationFlow
            import System
            func Select(early bool) managed[int32] {
                var value = 1
                let ref before = value
                let retained = managed({
                    if early { return managed(value) }
                    value
                })
                *retained = 3
                before += 4
                return retained
            }
            func Main() {
                Console.WriteLine(*Select(false))
                Console.WriteLine(*Select(true))
            }
            """, "ManagedLocationFlow", executable: true);
        IlVerifier.Verify(dll);
        Assert.Equal("7\n1\n", fixture.Run(dll));
    }

    private sealed class NodeCounter : BoundTreeWalker
    {
        internal int PersistentAddresses { get; private set; }

        internal int FieldKeys { get; private set; }

        internal void VisitProgram(BoundProgram program)
        {
            foreach (var body in program.Functions.Values)
            {
                this.Visit(body);
            }

            foreach (var type in program.Structs)
            {
                foreach (var initializer in (program.Initializers.ContainsKey((type, false))
                    ? Enumerable.Empty<BoundExpression>() : type.InstanceFieldInitializers.Values)
                    .Concat(program.Initializers.ContainsKey((type, true))
                        ? Enumerable.Empty<BoundExpression>() : type.StaticFieldInitializers.Values))
                {
                    this.VisitExpression(initializer);
                }
            }

            foreach (var plan in program.Initializers.Values)
            {
                this.Visit(plan.Prologue);
                foreach (var argument in plan.Arguments)
                {
                    this.VisitExpression(argument);
                }

                this.Visit(plan.Body);
            }
        }

        public override void VisitExpression(BoundExpression node)
        {
            this.PersistentAddresses += node is BoundManagedReferenceExpression ? 1 : 0;
            this.FieldKeys += node is BoundManagedFieldKeyExpression ? 1 : 0;
            if (node is BoundFunctionLiteralExpression literal)
            {
                this.Visit(literal.Body);
            }

            base.VisitExpression(node);
        }
    }
}
