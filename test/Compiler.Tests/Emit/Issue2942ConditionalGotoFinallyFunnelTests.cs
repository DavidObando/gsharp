// <copyright file="Issue2942ConditionalGotoFinallyFunnelTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2942: conditional exits from protected code must run a lifted
/// <c>finally</c> body before dispatching to their original target.
/// No source form currently produces this shape, so these tests inject the
/// sanctioned bound-tree regression directly into the emit pipeline.
/// </summary>
public class Issue2942ConditionalGotoFinallyFunnelTests
{
    private static readonly FieldInfo BoundProgramField = typeof(Compilation).GetField(
        "boundProgram",
        BindingFlags.Instance | BindingFlags.NonPublic)!;

    [Theory]
    [InlineData(true, 1)]
    [InlineData(false, 2)]
    public void Lowerer_FunnelsConditionalExit_AndLiftsConditionalFinallyExit(
        bool jumpIfTrue,
        int comparedValue)
    {
        var (body, tryExit, localTarget) = BuildBody(jumpIfTrue, comparedValue);

        var lowered = Lowerer.Lower(body);
        var escapingCollector = new BranchCollector(tryExit);
        escapingCollector.VisitStatement(lowered);
        var localCollector = new BranchCollector(localTarget);
        localCollector.VisitStatement(lowered);

        Assert.Equal(0, escapingCollector.ConditionalTargetCount);
        Assert.Equal(0, escapingCollector.FinallyCount);
        Assert.Equal(1, localCollector.ConditionalTargetCount);
    }

    [Theory]
    [InlineData(true, 1, 3)]
    [InlineData(false, 2, 3)]
    [InlineData(true, 2, 221)]
    [InlineData(false, 1, 221)]
    public void EmittedConditionalExit_PreservesPolarity_EvaluatesConditionOnce_AndRunsFinally(
        bool jumpIfTrue,
        int comparedValue,
        int expectedExitCode)
    {
        var (body, _, _) = BuildBody(jumpIfTrue, comparedValue);
        var program = BuildProgram(Lowerer.Lower(body));

        var bytes = Emit(program);
        VerifyLoadAndRunChild(bytes, expectedExitCode);
    }

    [Fact]
    public void EmittedCatchConditionalExit_RunsFinallyBeforeDispatch()
    {
        var program = BuildProgram(Lowerer.Lower(BuildCatchBody()));

        var bytes = Emit(program);
        VerifyLoadAndRunChild(bytes, expectedExitCode: 10);
    }

    [Theory]
    [InlineData(1, 11)]
    [InlineData(2, 61)]
    [InlineData(3, 200)]
    public void EmittedMultipleConditionalExits_DispatchSelectedTarget_AndRunFinallyOnce(
        int selectedTarget,
        int expectedExitCode)
    {
        var program = BuildProgram(Lowerer.Lower(BuildMultipleTargetBody(selectedTarget)));

        var bytes = Emit(program);
        VerifyLoadAndRunChild(bytes, expectedExitCode);
    }

    private static (BoundBlockStatement Body, BoundLabel TryExit, BoundLabel LocalTarget) BuildBody(
        bool jumpIfTrue,
        int comparedValue)
    {
        var counter = new LocalVariableSymbol("counter", isReadOnly: false, TypeSymbol.Int32);
        var result = new LocalVariableSymbol("result", isReadOnly: false, TypeSymbol.Int32);
        var finallyFlag = new LocalVariableSymbol("finallyFlag", isReadOnly: false, TypeSymbol.Bool);
        var tryExit = new BoundLabel("tryExit");
        var finallyExit = new BoundLabel("finallyExit");
        var localTarget = new BoundLabel("localTarget");

        var incrementCounter = new BoundAssignmentExpression(
            null,
            counter,
            Binary(Read(counter), SyntaxKind.PlusToken, Literal(1)));
        var condition = Binary(
            incrementCounter,
            SyntaxKind.EqualsEqualsToken,
            Literal(comparedValue));

        var tryBlock = Block(
            new BoundConditionalGotoStatement(
                null,
                localTarget,
                new BoundLiteralExpression(null, true),
                jumpIfTrue: true),
            Assign(result, Literal(50)),
            new BoundLabelStatement(null, localTarget),
            new BoundConditionalGotoStatement(null, tryExit, condition, jumpIfTrue),
            Assign(result, Literal(9)));
        var finallyBlock = Block(
            new BoundConditionalGotoStatement(
                null,
                finallyExit,
                Read(finallyFlag),
                jumpIfTrue: true),
            Assign(result, Binary(Read(result), SyntaxKind.PlusToken, Literal(1))));

        return (
            Block(
                new BoundVariableDeclaration(null, counter, Literal(0)),
                new BoundVariableDeclaration(null, result, Literal(0)),
                new BoundVariableDeclaration(
                    null,
                    finallyFlag,
                    new BoundLiteralExpression(null, false)),
                new BoundTryStatement(
                    null,
                    tryBlock,
                    ImmutableArray<BoundCatchClause>.Empty,
                    finallyBlock),
                Assign(result, Binary(Read(result), SyntaxKind.PlusToken, Literal(100))),
                new BoundLabelStatement(null, tryExit),
                new BoundReturnStatement(
                    null,
                    Binary(
                        Binary(Read(result), SyntaxKind.StarToken, Literal(2)),
                        SyntaxKind.PlusToken,
                        Read(counter))),
                new BoundLabelStatement(null, finallyExit),
                new BoundReturnStatement(null, Literal(-1))),
            tryExit,
            localTarget);
    }

    private static BoundBlockStatement BuildCatchBody()
    {
        var zero = new LocalVariableSymbol("zero", isReadOnly: false, TypeSymbol.Int32);
        var result = new LocalVariableSymbol("result", isReadOnly: false, TypeSymbol.Int32);
        var finallyFlag = new LocalVariableSymbol("finallyFlag", isReadOnly: false, TypeSymbol.Bool);
        var caught = new LocalVariableSymbol(
            "caught",
            isReadOnly: true,
            TypeSymbol.FromClrType(typeof(DivideByZeroException)));
        var catchExit = new BoundLabel("catchExit");
        var finallyExit = new BoundLabel("finallyExit");

        var tryBlock = Block(
            Assign(result, Binary(Literal(1), SyntaxKind.SlashToken, Read(zero))));
        var catchBlock = Block(
            new BoundConditionalGotoStatement(
                null,
                catchExit,
                new BoundLiteralExpression(null, true),
                jumpIfTrue: true),
            Assign(result, Literal(99)));
        var finallyBlock = Block(
            new BoundConditionalGotoStatement(
                null,
                finallyExit,
                Read(finallyFlag),
                jumpIfTrue: true),
            Assign(result, Binary(Read(result), SyntaxKind.PlusToken, Literal(3))));

        return Block(
            new BoundVariableDeclaration(null, zero, Literal(0)),
            new BoundVariableDeclaration(null, result, Literal(7)),
            new BoundVariableDeclaration(
                null,
                finallyFlag,
                new BoundLiteralExpression(null, false)),
            new BoundTryStatement(
                null,
                tryBlock,
                ImmutableArray.Create(
                    new BoundCatchClause(caught.Type, caught, catchBlock)),
                finallyBlock),
            Assign(result, Literal(100)),
            new BoundLabelStatement(null, catchExit),
            new BoundReturnStatement(null, Read(result)),
            new BoundLabelStatement(null, finallyExit),
            new BoundReturnStatement(null, Literal(-1)));
    }

    private static BoundBlockStatement BuildMultipleTargetBody(int selectedTarget)
    {
        var counter = new LocalVariableSymbol("counter", isReadOnly: false, TypeSymbol.Int32);
        var result = new LocalVariableSymbol("result", isReadOnly: false, TypeSymbol.Int32);
        var finallyFlag = new LocalVariableSymbol("finallyFlag", isReadOnly: false, TypeSymbol.Bool);
        var firstExit = new BoundLabel("firstExit");
        var secondExit = new BoundLabel("secondExit");
        var returnLabel = new BoundLabel("return");
        var finallyExit = new BoundLabel("finallyExit");

        BoundExpression NextCounterEqualsSelection()
            => Binary(
                new BoundAssignmentExpression(
                    null,
                    counter,
                    Binary(Read(counter), SyntaxKind.PlusToken, Literal(1))),
                SyntaxKind.EqualsEqualsToken,
                Literal(selectedTarget));

        var tryBlock = Block(
            Assign(result, Literal(10)),
            new BoundConditionalGotoStatement(
                null,
                firstExit,
                NextCounterEqualsSelection(),
                jumpIfTrue: true),
            Assign(result, Literal(20)),
            new BoundConditionalGotoStatement(
                null,
                secondExit,
                NextCounterEqualsSelection(),
                jumpIfTrue: true),
            Assign(result, Literal(119)));
        var finallyBlock = Block(
            new BoundConditionalGotoStatement(
                null,
                finallyExit,
                Read(finallyFlag),
                jumpIfTrue: true),
            Assign(result, Binary(Read(result), SyntaxKind.PlusToken, Literal(1))));

        return Block(
            new BoundVariableDeclaration(null, counter, Literal(0)),
            new BoundVariableDeclaration(null, result, Literal(0)),
            new BoundVariableDeclaration(
                null,
                finallyFlag,
                new BoundLiteralExpression(null, false)),
            new BoundTryStatement(
                null,
                tryBlock,
                ImmutableArray<BoundCatchClause>.Empty,
                finallyBlock),
            new BoundGotoStatement(null, returnLabel),
            new BoundLabelStatement(null, firstExit),
            new BoundReturnStatement(null, Read(result)),
            new BoundLabelStatement(null, secondExit),
            new BoundReturnStatement(
                null,
                Binary(Read(result), SyntaxKind.PlusToken, Literal(40))),
            new BoundLabelStatement(null, returnLabel),
            new BoundReturnStatement(
                null,
                Binary(Read(result), SyntaxKind.PlusToken, Literal(80))),
            new BoundLabelStatement(null, finallyExit),
            new BoundReturnStatement(null, Literal(-1)));
    }

    private static BoundExpression Read(VariableSymbol variable)
        => new BoundVariableExpression(null, variable);

    private static BoundExpression Literal(int value)
        => new BoundLiteralExpression(null, value);

    private static BoundExpression Binary(
        BoundExpression left,
        SyntaxKind kind,
        BoundExpression right)
        => new BoundBinaryExpression(
            null,
            left,
            BoundBinaryOperator.Bind(kind, left.Type, right.Type),
            right);

    private static BoundStatement Assign(VariableSymbol variable, BoundExpression expression)
        => new BoundExpressionStatement(
            null,
            new BoundAssignmentExpression(null, variable, expression));

    private static BoundProgram BuildProgram(BoundBlockStatement body)
    {
        var package = new PackageSymbol("Issue2942", declaration: null);
        var entryPoint = new FunctionSymbol(
            "Main",
            ImmutableArray<ParameterSymbol>.Empty,
            TypeSymbol.Int32,
            package: package);
        return new BoundProgram(
            package,
            ImmutableArray.Create(package),
            ImmutableArray<Diagnostic>.Empty,
            ImmutableDictionary<FunctionSymbol, BoundBlockStatement>.Empty.Add(entryPoint, body),
            entryPoint,
            Block());
    }

    private static byte[] Emit(BoundProgram program)
    {
        var compilation = new Compilation(
            SyntaxTree.Parse(SourceText.From("package Issue2942\nfunc Placeholder() {}")));
        BoundProgramField.SetValue(compilation, program);

        using var peStream = new MemoryStream();
        var emit = compilation.Emit(peStream);
        Assert.True(
            emit.Success,
            string.Join(
                Environment.NewLine,
                emit.Diagnostics.Select(diagnostic => $"{diagnostic.Id}: {diagnostic.Message}")));
        return peStream.ToArray();
    }

    private static void VerifyLoadAndRunChild(byte[] bytes, int expectedExitCode)
    {
        var prefix = $"Issue2942_{Guid.NewGuid():N}";
        var directory = Directory.GetCurrentDirectory();
        var assemblyPath = Path.Combine(directory, prefix + ".dll");
        var runtimeConfigPath = Path.Combine(directory, prefix + ".runtimeconfig.json");
        try
        {
            File.WriteAllBytes(assemblyPath, bytes);
            File.WriteAllText(
                runtimeConfigPath,
                $$"""
                  {
                    "runtimeOptions": {
                      "tfm": "net{{Environment.Version.Major}}.0",
                      "framework": {
                        "name": "Microsoft.NETCore.App",
                        "version": "{{Environment.Version.Major}}.0.0"
                      }
                    }
                  }
                  """);

            IlVerifier.Verify(assemblyPath);
            Assert.NotEmpty(EmittedFixture.Load(bytes).GetTypes());

            var start = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = directory,
            };
            start.ArgumentList.Add("exec");
            start.ArgumentList.Add("--runtimeconfig");
            start.ArgumentList.Add(runtimeConfigPath);
            start.ArgumentList.Add(assemblyPath);

            using var process = Process.Start(start)!;
            var stdoutTask = process.StandardOutput.ReadToEndAsync();
            var stderrTask = process.StandardError.ReadToEndAsync();
            var exited = process.WaitForExit(10_000);
            if (!exited)
            {
                process.Kill(entireProcessTree: true);
                Assert.True(process.WaitForExit(5_000), "child did not stop after kill");
            }

            var stdout = stdoutTask.GetAwaiter().GetResult();
            var stderr = stderrTask.GetAwaiter().GetResult();
            Assert.True(exited, $"child execution timed out\nstdout:\n{stdout}\nstderr:\n{stderr}");
            Assert.InRange(expectedExitCode, 0, byte.MaxValue);
            Assert.Equal(expectedExitCode, process.ExitCode);
            Assert.Equal(string.Empty, stdout);
            Assert.Equal(string.Empty, stderr);
        }
        finally
        {
            File.Delete(assemblyPath);
            File.Delete(runtimeConfigPath);
        }
    }

    private static BoundBlockStatement Block(params BoundStatement[] statements)
        => new(null, statements.ToImmutableArray());

    private sealed class BranchCollector : BoundTreeWalker
    {
        private readonly BoundLabel target;

        public BranchCollector(BoundLabel target)
        {
            this.target = target;
        }

        public int ConditionalTargetCount { get; private set; }

        public int FinallyCount { get; private set; }

        public override void VisitStatement(BoundStatement node)
        {
            if (node is BoundConditionalGotoStatement conditional
                && ReferenceEquals(conditional.Label, target))
            {
                ConditionalTargetCount++;
            }

            base.VisitStatement(node);
        }

        protected override void VisitTryStatement(BoundTryStatement node)
        {
            if (node.FinallyBlock != null)
            {
                FinallyCount++;
            }

            base.VisitTryStatement(node);
        }
    }
}
