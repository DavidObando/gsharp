// <copyright file="Issue2942ConditionalGotoFinallyFunnelTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Immutable
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import Xunit
import GSharp.Compiler.Tests

/// Issue #2942: conditional exits from protected code must run a lifted
/// `finally` body before dispatching to their original target.
/// No source form currently produces this shape, so these tests inject the
/// sanctioned bound-tree regression directly into the emit pipeline.
open class Issue2942ConditionalGotoFinallyFunnelTests {
    @Theory
    @InlineData(true, int32(1))
    @InlineData(false, int32(2))
    func Lowerer_FunnelsConditionalExit_AndLiftsConditionalFinallyExit(jumpIfTrue bool, comparedValue int32) {
        let (body, tryExit, localTarget) = BuildBody(jumpIfTrue, comparedValue)
        let lowered = Lowerer.Lower(body)
        let escapingCollector = BranchCollector(tryExit)
        escapingCollector.VisitStatement(lowered)
        let localCollector = BranchCollector(localTarget)
        localCollector.VisitStatement(lowered)
        Assert.Equal(0, escapingCollector.ConditionalTargetCount)
        Assert.Equal(0, escapingCollector.FinallyCount)
        Assert.Equal(1, localCollector.ConditionalTargetCount)
    }

    @Theory
    @InlineData(true, int32(1), int32(3))
    @InlineData(false, int32(2), int32(3))
    @InlineData(true, int32(2), int32(221))
    @InlineData(false, int32(1), int32(221))
    func EmittedConditionalExit_PreservesPolarity_EvaluatesConditionOnce_AndRunsFinally(
        jumpIfTrue bool,
        comparedValue int32,
        expectedExitCode int32
    ) {
        let (body, _, _) = BuildBody(jumpIfTrue, comparedValue)
        let program = BuildProgram(Lowerer.Lower(body))
        let bytes = Emit(program)
        VerifyLoadAndRunChild(bytes, expectedExitCode)
    }

    @Fact
    func EmittedCatchConditionalExit_RunsFinallyBeforeDispatch() {
        let program = BuildProgram(Lowerer.Lower(BuildCatchBody()))
        let bytes = Emit(program)
        VerifyLoadAndRunChild(bytes, expectedExitCode: 10)
    }

    @Theory
    @InlineData(int32(1), int32(11))
    @InlineData(int32(2), int32(61))
    @InlineData(int32(3), int32(200))
    func EmittedMultipleConditionalExits_DispatchSelectedTarget_AndRunFinallyOnce(
        selectedTarget int32,
        expectedExitCode int32
    ) {
        let program = BuildProgram(Lowerer.Lower(BuildMultipleTargetBody(selectedTarget)))
        let bytes = Emit(program)
        VerifyLoadAndRunChild(bytes, expectedExitCode)
    }

    private class BranchCollector : BoundTreeWalker {
        private let target BoundLabel

        init(target BoundLabel) {
            this.target = target
        }

        prop ConditionalTargetCount int32 {
            get;
            private set;
        }

        prop FinallyCount int32 {
            get;
            private set;
        }

        override func VisitStatement(node BoundStatement) {
            if node is BoundConditionalGotoStatement conditional && object.ReferenceEquals(conditional.Label, target) {
                ConditionalTargetCount++
            }
            base.VisitStatement(node)
        }

        protected override func VisitTryStatement(node BoundTryStatement) {
            if node.FinallyBlock != nil {
                FinallyCount++
            }
            base.VisitTryStatement(node)
        }
    }

    shared {
        private let BoundProgramField FieldInfo = typeof(Compilation).GetField(
            "boundProgram",
            BindingFlags.Instance | BindingFlags.NonPublic
        )!!

        private func BuildBody(jumpIfTrue bool, comparedValue int32)(
            Body BoundBlockStatement,
            TryExit BoundLabel,
            LocalTarget BoundLabel
        ) {
            let counter = LocalVariableSymbol("counter", isReadOnly: false, TypeSymbol.Int32)
            let result = LocalVariableSymbol("result", isReadOnly: false, TypeSymbol.Int32)
            let finallyFlag = LocalVariableSymbol("finallyFlag", isReadOnly: false, TypeSymbol.Bool)
            let tryExit = BoundLabel("tryExit")
            let finallyExit = BoundLabel("finallyExit")
            let localTarget = BoundLabel("localTarget")
            let incrementCounter = BoundAssignmentExpression(
                nil,
                counter,
                Binary(Read(counter), SyntaxKind.PlusToken, Literal(1))
            )
            let condition = Binary(incrementCounter, SyntaxKind.EqualsEqualsToken, Literal(comparedValue))
            let tryBlock = Block(
                BoundConditionalGotoStatement(nil, localTarget, BoundLiteralExpression(nil, true), jumpIfTrue: true),
                Assign(result, Literal(50)),
                BoundLabelStatement(nil, localTarget),
                BoundConditionalGotoStatement(nil, tryExit, condition, jumpIfTrue),
                Assign(result, Literal(9))
            )
            let finallyBlock = Block(
                BoundConditionalGotoStatement(nil, finallyExit, Read(finallyFlag), jumpIfTrue: true),
                Assign(result, Binary(Read(result), SyntaxKind.PlusToken, Literal(1)))
            )
            return (
                Block(
                    BoundVariableDeclaration(nil, counter, Literal(0)),
                    BoundVariableDeclaration(nil, result, Literal(0)),
                    BoundVariableDeclaration(nil, finallyFlag, BoundLiteralExpression(nil, false)),
                    BoundTryStatement(nil, tryBlock, ImmutableArray[BoundCatchClause].Empty, finallyBlock),
                    Assign(result, Binary(Read(result), SyntaxKind.PlusToken, Literal(100))),
                    BoundLabelStatement(nil, tryExit),
                    BoundReturnStatement(
                        nil,
                        Binary(
                            Binary(Read(result), SyntaxKind.StarToken, Literal(2)),
                            SyntaxKind.PlusToken,
                            Read(counter)
                        )
                    ),
                    BoundLabelStatement(nil, finallyExit),
                    BoundReturnStatement(nil, Literal(-1))
                ),
                tryExit,
                localTarget
            )
        }

        private func BuildCatchBody() BoundBlockStatement {
            let zero = LocalVariableSymbol("zero", isReadOnly: false, TypeSymbol.Int32)
            let result = LocalVariableSymbol("result", isReadOnly: false, TypeSymbol.Int32)
            let finallyFlag = LocalVariableSymbol("finallyFlag", isReadOnly: false, TypeSymbol.Bool)
            let caught = LocalVariableSymbol(
                "caught",
                isReadOnly: true,
                TypeSymbol.FromClrType(typeof(DivideByZeroException))
            )
            let catchExit = BoundLabel("catchExit")
            let finallyExit = BoundLabel("finallyExit")
            let tryBlock = Block(Assign(result, Binary(Literal(1), SyntaxKind.SlashToken, Read(zero))))
            let catchBlock = Block(
                BoundConditionalGotoStatement(nil, catchExit, BoundLiteralExpression(nil, true), jumpIfTrue: true),
                Assign(result, Literal(99))
            )
            let finallyBlock = Block(
                BoundConditionalGotoStatement(nil, finallyExit, Read(finallyFlag), jumpIfTrue: true),
                Assign(result, Binary(Read(result), SyntaxKind.PlusToken, Literal(3)))
            )
            return Block(
                BoundVariableDeclaration(nil, zero, Literal(0)),
                BoundVariableDeclaration(nil, result, Literal(7)),
                BoundVariableDeclaration(nil, finallyFlag, BoundLiteralExpression(nil, false)),
                BoundTryStatement(
                    nil,
                    tryBlock,
                    ImmutableArray.Create(BoundCatchClause(caught.Type, caught, catchBlock)),
                    finallyBlock
                ),
                Assign(result, Literal(100)),
                BoundLabelStatement(nil, catchExit),
                BoundReturnStatement(nil, Read(result)),
                BoundLabelStatement(nil, finallyExit),
                BoundReturnStatement(nil, Literal(-1))
            )
        }

        private func BuildMultipleTargetBody(selectedTarget int32) BoundBlockStatement {
            let counter = LocalVariableSymbol("counter", isReadOnly: false, TypeSymbol.Int32)
            let result = LocalVariableSymbol("result", isReadOnly: false, TypeSymbol.Int32)
            let finallyFlag = LocalVariableSymbol("finallyFlag", isReadOnly: false, TypeSymbol.Bool)
            let firstExit = BoundLabel("firstExit")
            let secondExit = BoundLabel("secondExit")
            let returnLabel = BoundLabel("return")
            let finallyExit = BoundLabel("finallyExit")
            let NextCounterEqualsSelection = func () BoundExpression {
                return Binary(
                    BoundAssignmentExpression(nil, counter, Binary(Read(counter), SyntaxKind.PlusToken, Literal(1))),
                    SyntaxKind.EqualsEqualsToken,
                    Literal(selectedTarget)
                )
            }
            let tryBlock = Block(
                Assign(result, Literal(10)),
                BoundConditionalGotoStatement(nil, firstExit, NextCounterEqualsSelection(), jumpIfTrue: true),
                Assign(result, Literal(20)),
                BoundConditionalGotoStatement(nil, secondExit, NextCounterEqualsSelection(), jumpIfTrue: true),
                Assign(result, Literal(119))
            )
            let finallyBlock = Block(
                BoundConditionalGotoStatement(nil, finallyExit, Read(finallyFlag), jumpIfTrue: true),
                Assign(result, Binary(Read(result), SyntaxKind.PlusToken, Literal(1)))
            )
            return Block(
                BoundVariableDeclaration(nil, counter, Literal(0)),
                BoundVariableDeclaration(nil, result, Literal(0)),
                BoundVariableDeclaration(nil, finallyFlag, BoundLiteralExpression(nil, false)),
                BoundTryStatement(nil, tryBlock, ImmutableArray[BoundCatchClause].Empty, finallyBlock),
                BoundGotoStatement(nil, returnLabel),
                BoundLabelStatement(nil, firstExit),
                BoundReturnStatement(nil, Read(result)),
                BoundLabelStatement(nil, secondExit),
                BoundReturnStatement(nil, Binary(Read(result), SyntaxKind.PlusToken, Literal(40))),
                BoundLabelStatement(nil, returnLabel),
                BoundReturnStatement(nil, Binary(Read(result), SyntaxKind.PlusToken, Literal(80))),
                BoundLabelStatement(nil, finallyExit),
                BoundReturnStatement(nil, Literal(-1))
            )
        }

        private func Read(variable VariableSymbol) BoundExpression -> BoundVariableExpression(nil, variable)

        private func Literal(value int32) BoundExpression -> BoundLiteralExpression(nil, value)

        private func Binary(
            left BoundExpression,
            kind SyntaxKind,
            right BoundExpression
        ) BoundExpression -> BoundBinaryExpression(
            nil,
            left,
            BoundBinaryOperator.Bind(kind, left.Type, right.Type)!!,
            right
        )

        private func Assign(
            variable VariableSymbol,
            expression BoundExpression
        ) BoundStatement -> BoundExpressionStatement(nil, BoundAssignmentExpression(nil, variable, expression))

        private func BuildProgram(body BoundBlockStatement) BoundProgram {
            let package_ = PackageSymbol("Issue2942", declaration: nil)
            let entryPoint = FunctionSymbol(
                "Main",
                ImmutableArray[ParameterSymbol].Empty,
                TypeSymbol.Int32,
                $package: package_
            )
            return BoundProgram(
                package_,
                ImmutableArray.Create(package_),
                ImmutableArray[Diagnostic].Empty,
                ImmutableDictionary[FunctionSymbol, BoundBlockStatement].Empty.Add(entryPoint, body),
                entryPoint,
                Block()
            )
        }

        private func Emit(program BoundProgram)[]uint8 {
            let compilation = Compilation(SyntaxTree.Parse(SourceText.From("package Issue2942\nfunc Placeholder() {}")))
            BoundProgramField.SetValue(compilation, program)
            using let peStream = MemoryStream()
            let emit = compilation.Emit(peStream)
            Assert.True(
                emit.Success,
                string.Join(
                    Environment.NewLine,
                    emit.Diagnostics.Select((diagnostic Diagnostic) -> "${diagnostic.Id}: ${diagnostic.Message}")
                )
            )
            return peStream.ToArray()
        }

        private func VerifyLoadAndRunChild(bytes[]uint8, expectedExitCode int32) {
            let prefix = "Issue2942_${Guid.NewGuid():N}"
            let directory = Directory.GetCurrentDirectory()
            let assemblyPath = Path.Combine(directory, prefix + ".dll")
            let runtimeConfigPath = Path.Combine(directory, prefix + ".runtimeconfig.json")
            try {
                File.WriteAllBytes(assemblyPath, bytes)
                File.WriteAllText(runtimeConfigPath, (`{
  "runtimeOptions": {
    "tfm": "net` + "${Environment.Version.Major}" + `.0",
    "framework": {
      "name": "Microsoft.NETCore.App",
      "version": "` + "${Environment.Version.Major}" + `.0.0"
    }
  }
}`))
                IlVerifier.Verify(assemblyPath)
                Assert.NotEmpty(EmittedFixture.Load(bytes).GetTypes())
                let start = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = directory
                }
                start.ArgumentList.Add("exec")
                start.ArgumentList.Add("--runtimeconfig")
                start.ArgumentList.Add(runtimeConfigPath)
                start.ArgumentList.Add(assemblyPath)
                using let process = Process.Start(start)!!
                let stdoutTask = process.StandardOutput.ReadToEndAsync()
                let stderrTask = process.StandardError.ReadToEndAsync()
                let exited = process.WaitForExit(10_000)
                if !exited {
                    process.Kill(entireProcessTree: true)
                    Assert.True(process.WaitForExit(5_000), "child did not stop after kill")
                }
                let stdout = stdoutTask.GetAwaiter().GetResult()
                let stderr = stderrTask.GetAwaiter().GetResult()
                Assert.True(exited, (`child execution timed out
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                Assert.InRange(expectedExitCode, 0, int32(uint8.MaxValue))
                Assert.Equal(expectedExitCode, process.ExitCode)
                Assert.Equal(string.Empty, stdout)
                Assert.Equal(string.Empty, stderr)
            } finally {
                File.Delete(assemblyPath)
                File.Delete(runtimeConfigPath)
            }
        }

        private func Block(statements ...BoundStatement) BoundBlockStatement -> BoundBlockStatement(
            nil,
            statements.ToImmutableArray()
        )
    }
}
