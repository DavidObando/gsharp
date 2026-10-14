// <copyright file="ConstantNarrowingCoverageTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Binding

import System
import System.IO
import System.Linq
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import Compilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import SyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import GSharp.Core.CodeAnalysis

open class ConstantNarrowingCoverageTests {
    @Fact
    func ImportedInstanceCall_InRangeIntegerLiteral_IsAccepted() {
        AssertCompiles(`package constant_narrowing_instance_ok
import GSharp.Compiler.Tests.Binding

func Main() {
    var target = ConstantNarrowingMethodTarget()
    target.Instance(5)
}`)
    }

    @Fact
    func ImportedInstanceCall_OutOfRangeIntegerLiteral_IsRejected() {
        AssertGs0159(`package constant_narrowing_instance_bad
import GSharp.Compiler.Tests.Binding

func Main() {
    var target = ConstantNarrowingMethodTarget()
    target.Instance(300)
}`)
    }

    @Fact
    func ConstrainedImportedInterfaceCall_InRangeIntegerLiteral_IsAccepted() {
        AssertCompiles(`package constant_narrowing_constraint_ok
import GSharp.Compiler.Tests.Binding

func Call[T IConstantNarrowingSink](sink T) {
    sink.Take(5)
}`)
    }

    @Fact
    func ConstrainedImportedInterfaceCall_OutOfRangeIntegerLiteral_IsRejected() {
        AssertGs0159(`package constant_narrowing_constraint_bad
import GSharp.Compiler.Tests.Binding

func Call[T IConstantNarrowingSink](sink T) {
    sink.Take(300)
}`)
    }

    @Theory
    @InlineData(int32(0))
    @InlineData(int32(5))
    @InlineData(int32(255))
    func ImportedBaseConstructorInitializer_InRangeIntegerLiteral_IsAccepted(value int32) {
        AssertCompiles((`package constant_narrowing_base_ok
import GSharp.Compiler.Tests.Binding

class Derived : ConstantNarrowingBase {
    init() : base(` + "$value" + `) {}
}`))
    }

    @Theory
    @InlineData(int32(-1))
    @InlineData(int32(256))
    @InlineData(int32(300))
    func ImportedBaseConstructorInitializer_OutOfRangeIntegerLiteral_IsRejected(value int32) {
        let result = Compile((`package constant_narrowing_base_bad
import GSharp.Compiler.Tests.Binding

class Derived : ConstantNarrowingBase {
    init() : base(` + "$value" + `) {}
}`))
        Assert.False(result.Success)
        Assert.Contains(result.Diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Id == "GS0267")
        Assert.DoesNotContain(
            result.Diagnostics,
            (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Id == "GS0157" || d.Id == "GS0213"
        )
    }

    @Fact
    func ImportedOperator_InRangeIntegerLiteral_StillRejectedUntilOperatorBinderPassesOperands() {
        AssertRejected(`package constant_narrowing_operator_gap
import GSharp.Compiler.Tests.Binding

func Main() {
    var value = ConstantNarrowingOperatorTarget()
    var _ = value + 5
}`)
    }

    shared {
        private func AssertCompiles(source string) {
            let result = Compile(source)
            Assert.True(
                result.Success,
                "Expected successful compilation; got: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d GSharp.Core.CodeAnalysis.Diagnostic) -> "[${d.Id}] ${d.Message}")
                )
            )
        }

        private func AssertGs0159(source string) {
            let result = Compile(source)
            Assert.False(result.Success)
            Assert.Contains(result.Diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Id == "GS0159")
        }

        private func AssertRejected(source string) {
            let result = Compile(source)
            Assert.False(result.Success)
            Assert.NotEmpty(result.Diagnostics)
        }

        private func Compile(source string) GSharp.Core.CodeAnalysis.Compilation.EmitResult {
            let directory = Path.Combine(AppContext.BaseDirectory, "constant-narrowing", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            try {
                // #4129/#4206: these are imported C# contracts, not G# fixtures.
                // Migrating the ambient test assembly sealed the otherwise unsealed base.
                let referencePath = Path.Combine(directory, "ConstantNarrowingContracts.dll")
                let contracts = CSharpCompilation.Create(
                    "ConstantNarrowingContracts",
                    []Microsoft.CodeAnalysis.SyntaxTree{CSharpSyntaxTree.ParseText(ContractsSource)},
                    []PortableExecutableReference{MetadataReference.CreateFromFile(typeof(object).Assembly.Location)},
                    CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                )
                {
                    using let referenceStream = File.Create(referencePath)
                    let emitted = contracts.Emit(referenceStream)
                    Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
                }
                using let references = ReferenceResolver.WithReferences([]string{referencePath})
                Assert.True(
                    references.TryResolveType("GSharp.Compiler.Tests.Binding.ConstantNarrowingBase", out var baseType)
                )
                Assert.False(baseType.IsSealed)
                Assert.Equal(
                    "System.Byte",
                    Assert.Single(Assert.Single(baseType.GetConstructors()).GetParameters()).ParameterType.FullName
                )
                let sourceText = SourceText.From(source, "constant_narrowing_coverage.gs")
                let tree = SyntaxTree.Parse(sourceText)
                let compilation = Compilation(references, tree){IsLibrary = true}
                using let peStream = MemoryStream()
                return compilation.Emit(peStream, refStream: nil)
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }

        private const ContractsSource string = `namespace GSharp.Compiler.Tests.Binding;

public class ConstantNarrowingMethodTarget
{
    public void Instance(byte value) {}
}

public interface IConstantNarrowingSink
{
    void Take(byte value);
}

public class ConstantNarrowingBase
{
    public ConstantNarrowingBase(byte value) {}
}

public readonly struct ConstantNarrowingOperatorTarget
{
    public static ConstantNarrowingOperatorTarget operator +(ConstantNarrowingOperatorTarget left, byte right) => left;
}`
    }
}
