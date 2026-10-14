// <copyright file="Issue2831NegativeAttributeArgumentEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Tests
import System
import System.Collections.Generic
import System.Collections.ObjectModel
import System.IO
import System.Linq
import System.Reflection
import Xunit

/// Issue #2831: a negative numeric literal parses as a
/// `UnaryExpressionSyntax`, which `DeclarationBinder.TryBindAttributeArgument`
/// did not recognise, so every negative attribute argument — scalar or array
/// element — was rejected with GS0202 ("attribute argument must be a
/// compile-time constant"). These tests drive `gsc` against the host's real
/// `xunit.core.dll` (the exact shape that blocked
/// `corpus/L3-Library`) and assert both that the source binds and that the
/// emitted `CustomAttribute` blob round-trips the negative values.
open class Issue2831NegativeAttributeArgumentEmitTests {
    @Fact
    func NegativeLiterals_InScalarAndArrayArguments_RoundTrip() {
        // The exact repro shape from corpus/L3-Library's AdvancedTests.
        let source = `package P
import System
import Xunit

public class Facts {
    @Theory
    @InlineData([]int32{-2, -7, -1}, -1)
    public func Smallest(values []int32, expected int32) {
    }
}`
        let arguments = SingleInlineDataArguments(source, "Smallest")
        Assert.Equal([]int32{-2, -7, -1}, ArrayArgument(arguments[0]))
        Assert.Equal(-1, arguments[1].Value)
    }

    @Fact
    func MixedSignLiterals_RoundTrip() {
        let source = `package P
import System
import Xunit

public class Facts {
    @Theory
    @InlineData([]int32{3, -4, 0}, 7)
    public func Mixed(values []int32, expected int32) {
    }
}`
        let arguments = SingleInlineDataArguments(source, "Mixed")
        Assert.Equal([]int32{3, -4, 0}, ArrayArgument(arguments[0]))
        Assert.Equal(7, arguments[1].Value)
    }

    @Fact
    func NegativeFloatingPointLiteral_RoundTrips() {
        let source = `package P
import System
import Xunit

public class Facts {
    @Theory
    @InlineData(-2.5, -1.25)
    public func Scaled(value float64, expected float64) {
    }
}`
        let arguments = SingleInlineDataArguments(source, "Scaled")
        Assert.Equal(-2.5d, arguments[0].Value)
        Assert.Equal(-1.25d, arguments[1].Value)
    }

    shared {
        private func ArrayArgument(argument CustomAttributeTypedArgument)[]int32 {
            let elements = Assert.IsAssignableFrom[ReadOnlyCollection[CustomAttributeTypedArgument]](argument.Value)
            return elements.Select((e CustomAttributeTypedArgument) -> int32(e.Value)).ToArray()
        }

        private func SingleInlineDataArguments(source string, methodName string) IList[CustomAttributeTypedArgument] {
            let assembly = CompileToAssembly(source)
            let facts = assembly.GetTypes().Single((t Type) -> t.Name == "Facts")
            let method MethodInfo? = facts.GetMethod(methodName, BindingFlags.Public | BindingFlags.Instance)
            Assert.NotNull(method)
            let data = method!!.GetCustomAttributesData().Single(
                (d CustomAttributeData) -> d.AttributeType.Name == "InlineDataAttribute"
            )
            // xUnit's InlineDataAttribute takes a single `params object[]`, so the
            // whole argument list arrives as one array-typed constructor argument.
            return Assert.IsAssignableFrom[ReadOnlyCollection[CustomAttributeTypedArgument]](
                Assert.Single(data.ConstructorArguments).Value
            )
        }

        private func CompileToAssembly(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_negattr_emit_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let testDir string? = Path.GetDirectoryName(
                typeof(Issue2831NegativeAttributeArgumentEmitTests).Assembly.Location
            )
            let args = List[string]{"/out:" + outPath, "/target:library", "/targetframework:net10.0"}
            for name in[]string{"xunit.core.dll", "xunit.abstractions.dll"} {
                let path = Path.Combine(testDir!!, name)
                Assert.True(File.Exists(path), "prerequisite missing: '$path'")
                args.Add("/reference:" + path)
            }
            args.Add(srcPath)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            return EmittedFixture.Load(outPath)
        }
    }
}
