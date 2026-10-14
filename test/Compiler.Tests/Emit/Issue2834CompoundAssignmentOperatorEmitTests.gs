// <copyright file="Issue2834CompoundAssignmentOperatorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis.Text
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #2834 — real-assembly, reflection-metadata, IL-verification and
/// runtime-execution coverage for user-defined compound-assignment operators.
///
/// A compound-assignment operator is the ONE operator family that is not
/// emitted as a static `op_*` method (contrast issue #2377): C# 14
/// defines `op_AdditionAssignment` and siblings as INSTANCE,
/// `specialname`, `void`-returning, single-parameter
/// methods that mutate the receiver in place. These tests assert the emitted
/// metadata matches that contract byte for byte, that a REAL C#-authored
/// consumer can drive it with native `bag += 5` syntax, and that the
/// in-place mutation actually happens at runtime for local, field and
/// getter-only-property receivers.
///
/// Binder/parser-level coverage lives in
/// `Issue2834CompoundAssignmentOperatorTests` (Core.Tests).
open class Issue2834CompoundAssignmentOperatorEmitTests {
    @Theory
    @InlineData("+=", "op_AdditionAssignment")
    @InlineData("-=", "op_SubtractionAssignment")
    @InlineData("*=", "op_MultiplicationAssignment")
    @InlineData("/=", "op_DivisionAssignment")
    @InlineData("%=", "op_ModulusAssignment")
    @InlineData("&=", "op_BitwiseAndAssignment")
    @InlineData("|=", "op_BitwiseOrAssignment")
    @InlineData("^=", "op_ExclusiveOrAssignment")
    @InlineData("<<=", "op_LeftShiftAssignment")
    @InlineData(">>=", "op_RightShiftAssignment")
    @InlineData(">>>=", "op_UnsignedRightShiftAssignment")
    func InBodyCompoundOperator_EmitsAsPublicInstanceSpecialNameVoid(token string, clrName string) {
        let libraryPath = EmitGSharpLibrary("InBody_" + clrName, (`package Lib

public class Bag {
    public var Total int32

    public func operator ` + "$token" + `(amount int32) {
        Total = amount
    }
}`))
        let method = LoadDeclaredMethod(libraryPath, "Bag", clrName)
        Assert.False(method.IsStatic)
        Assert.True(method.IsSpecialName)
        Assert.True(method.IsPublic)
        Assert.True(method.IsHideBySig)
        Assert.Equal(typeof(Void), method.ReturnType)
        Assert.Single(method.GetParameters())
        Assert.Equal(typeof(int32), method.GetParameters()[0].ParameterType)
    }

    @Fact
    func ReceiverClauseCompoundOperator_EmitsTheSameInstanceShape() {
        // The receiver-clause form is deliberately excluded from the
        // receiver-clause -> static `op_*` rewrite that issue #2377 introduced
        // for binary/unary operators, so both spellings land identically.
        let libraryPath = EmitGSharpLibrary("ReceiverClause", `package Lib

public class Bag {
    public var Total int32
}

func (b Bag) operator +=(amount int32) {
    b.Total = b.Total + amount
}`)
        let method = LoadDeclaredMethod(libraryPath, "Bag", "op_AdditionAssignment")
        Assert.False(method.IsStatic)
        Assert.True(method.IsSpecialName)
        Assert.Equal(typeof(Void), method.ReturnType)
        // The receiver becomes the implicit `this`, NOT a leading parameter.
        Assert.Single(method.GetParameters())
        Assert.Equal(typeof(int32), method.GetParameters()[0].ParameterType)
    }

    @Fact
    func CSharpConsumer_CanDriveGSharpCompoundOperator_ViaNativeSyntax() {
        let libraryPath = EmitGSharpLibrary("CSharpConsumer", `package Lib

public class Bag {
    public var Total int32

    public func operator +=(amount int32) {
        Total = Total + amount
    }

    public func operator -=(amount int32) {
        Total = Total - amount
    }
}`)
        let consumerPath = EmitCSharpConsumer("CSharpConsumer_CanDriveGSharpCompoundOperator_ViaNativeSyntax", `using Lib;

namespace Consumer
{
    public static class Runner
    {
        public static int Run()
        {
            Bag bag = new Bag();
            bag += 5;
            bag += 7;
            bag -= 2;
            return bag.Total;
        }
    }
}`, libraryPath)
        let loadContext = AssemblyLoadContext(
            "CSharpConsumer_CanDriveGSharpCompoundOperator_ViaNativeSyntax",
            isCollectible: true
        )
        try {
            let libraryAsm = loadContext.LoadFromAssemblyPath(libraryPath)
            loadContext.Resolving += (ctx AssemblyLoadContext, name AssemblyName) -> if name.Name == libraryAsm
                .GetName().Name {
                libraryAsm
            } else {
                default(Assembly?)
            }
            let consumerAsm = loadContext.LoadFromAssemblyPath(consumerPath)
            let runner = consumerAsm.GetType("Consumer.Runner")!!
            Assert.Equal(10, runner.GetMethod("Run")!!.Invoke(nil, nil))
        } finally {
            loadContext.Unload()
        }
    }

    @Fact
    func CompoundOperator_MutatesInPlace_ForLocalFieldAndGetterOnlyPropertyReceivers() {
        let libraryPath = EmitGSharpLibrary("Runtime", `package Lib

public class Bag {
    public var Total int32

    public func operator +=(amount int32) {
        Total = Total + amount
    }
}

public class Holder {
    public var Inner Bag
    public prop Only Bag { get { return Inner } }
}

public class Driver {
    shared {
        public func RunLocal() int32 {
            var bag = Bag()
            bag += 5
            bag += 7
            return bag!!.Total
        }

        public func RunField() int32 {
            var h = Holder()
            h!!.Inner = Bag()
            h!!.Inner += 3
            return h!!.Inner!!.Total
        }

        public func RunGetterOnlyProperty() int32 {
            var h = Holder()
            h!!.Inner = Bag()
            h!!.Only += 4
            return h!!.Inner!!.Total
        }
    }
}`)
        let loadContext = AssemblyLoadContext(
            "CompoundOperator_MutatesInPlace_ForLocalFieldAndGetterOnlyPropertyReceivers",
            isCollectible: true
        )
        try {
            let libraryAsm = loadContext.LoadFromAssemblyPath(libraryPath)
            let driver = libraryAsm.GetTypes().Single((t Type) -> t.Name == "Driver")
            Assert.Equal(12, driver.GetMethod("RunLocal", BindingFlags.Public | BindingFlags.Static)!!.Invoke(nil, nil))
            Assert.Equal(3, driver.GetMethod("RunField", BindingFlags.Public | BindingFlags.Static)!!.Invoke(nil, nil))
            Assert.Equal(
                4,
                driver.GetMethod("RunGetterOnlyProperty", BindingFlags.Public | BindingFlags.Static)!!.Invoke(nil, nil)
            )
        } finally {
            loadContext.Unload()
        }
    }

    @Fact
    func GSharpConsumer_CanDriveCSharpAuthoredCompoundOperator() {
        // The reverse interop direction: a Roslyn-emitted `op_AdditionAssignment`
        // is currently NOT consumable from G# (resolution requires a G#
        // StructSymbol receiver). This test pins the emitted C# shape so the
        // day that lands there is a fixture to point at, and documents that the
        // two compilers agree on the metadata contract.
        let csharpLibraryPath = EmitCSharpLibrary("GSharpConsumer_CanDriveCSharpAuthoredCompoundOperator", `namespace CsLib
{
    public class Bag
    {
        public int Total;

        public void operator +=(int amount) => Total += amount;
    }
}`)
        let loadContext = AssemblyLoadContext(
            "GSharpConsumer_CanDriveCSharpAuthoredCompoundOperator",
            isCollectible: true
        )
        try {
            let asm = loadContext.LoadFromAssemblyPath(csharpLibraryPath)
            let bag = asm.GetTypes().Single((t Type) -> t.Name == "Bag")
            let op = bag.GetMethod(
                "op_AdditionAssignment",
                BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly
            )!!
            Assert.False(op.IsStatic)
            Assert.True(op.IsSpecialName)
            Assert.Equal(typeof(Void), op.ReturnType)
            Assert.Single(op.GetParameters())
        } finally {
            loadContext.Unload()
        }
    }

    shared {
        private func LoadDeclaredMethod(libraryPath string, typeName string, methodName string) MethodInfo {
            let loadContext = AssemblyLoadContext("Probe_" + typeName + "_" + methodName, isCollectible: true)
            try {
                let asm = loadContext.LoadFromAssemblyPath(libraryPath)
                let type = asm.GetTypes().Single((t Type) -> t.Name == typeName)
                let method MethodInfo? = type.GetMethod(
                    methodName,
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance | BindingFlags.DeclaredOnly
                )
                Assert.NotNull(method)
                // Snapshot the facts before unloading; MethodInfo itself is not
                // usable after the context goes away.
                return method!!
            } finally {
                // Intentionally NOT unloaded: the returned MethodInfo is inspected
                // by the caller. The collectible context is reclaimed by the GC once
                // the test's references drop.

            }
        }

        private func EmitGSharpLibrary(caseName string, gsharpSource string) string {
            let assemblyPath = Path.Combine(LibraryDirectory(), "Issue2834Emit." + caseName + ".dll")
            let compilation = GsCompilation(GsSyntaxTree.Parse(SourceText.From(gsharpSource))){IsLibrary = true}
            {
                using let peStream = File.Create(assemblyPath)
                let result = compilation.Emit(
                    peStream,
                    pdbStream: nil,
                    refStream: nil,
                    assemblyName: "Issue2834Emit." + caseName
                )
                Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            }
            IlVerifier.Verify(assemblyPath)
            return assemblyPath
        }

        private func EmitCSharpConsumer(
            caseName string,
            csharpSource string,
            libraryPath string
        ) string -> EmitCSharpAssembly(caseName, "CSharpConsumer2834", csharpSource, libraryPath)

        private func EmitCSharpLibrary(caseName string, csharpSource string) string -> EmitCSharpAssembly(
            caseName,
            "CSharpLibrary2834",
            csharpSource,
            libraryPath: nil
        )

        private func EmitCSharpAssembly(
            caseName string,
            assemblyName string,
            csharpSource string,
            libraryPath string?
        ) string {
            let outputDir = Path.Combine(LibraryDirectory(), caseName)
            Directory.CreateDirectory(outputDir)
            let outputPath = Path.Combine(outputDir, assemblyName + ".dll")
            let syntaxTree = CSharpSyntaxTree.ParseText(csharpSource, CSharpParseOptions(LanguageVersion.Preview))
            let referencePaths = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(
                Path.PathSeparator
            ) ??
                Array.Empty[string]()
            let references = referencePaths
                .Where(File.Exists)
                .Select((p string) -> cast[MetadataReference](MetadataReference.CreateFromFile(p)))
                .ToList()
            if libraryPath != nil {
                references.Add(MetadataReference.CreateFromFile(libraryPath))
            }
            let compilation = CSharpCompilation.Create(
                assemblyName,
                []Microsoft.CodeAnalysis.SyntaxTree{syntaxTree},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            {
                using let peStream = File.Create(outputPath)
                let emitResult = compilation.Emit(peStream)
                Assert.True(emitResult.Success, string.Join(Environment.NewLine, emitResult.Diagnostics))
            }
            return outputPath
        }

        private func LibraryDirectory() string {
            let dir = Path.Combine(AppContext.BaseDirectory, "Issue2834Emit")
            Directory.CreateDirectory(dir)
            return dir
        }
    }
}
