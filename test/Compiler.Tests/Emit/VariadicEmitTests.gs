// <copyright file="VariadicEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Diagnostics
import System.IO
import System.Linq
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests
import System.Reflection

/// Phase 4.8 emit-parity regression tests for user-defined variadic
/// functions. Variadic packing is performed by the binder
/// (Binder.BindCallExpression wraps trailing args in a
/// `BoundArrayCreationExpression` of the slice element type) before the
/// expression reaches the emitter, so the emit path is exercised entirely
/// through pre-existing nodes; these tests guard against regressions in
/// either side. BCL params calls (e.g. `Console.WriteLine(string, params
/// object[])`) are tracked separately; the binder's overload resolution
/// does not expand params overloads today.
open class VariadicEmitTests {
    @Fact
    func VariadicSum_MultipleArgs() {
        let source = `package P
import System

func sum(nums ...int32) int32 {
  var total = 0
  for v in nums {
    total = total + v
  }
  return total
}

Console.WriteLine(sum(1, 2, 3, 4, 5))`
        let output = CompileAndRun(source)
        Assert.Equal("15${Environment.NewLine}", output)
    }

    @Fact
    func VariadicSum_ZeroAndOneArg() {
        let source = `package P
import System

func sum(nums ...int32) int32 {
  var total = 0
  for v in nums {
    total = total + v
  }
  return total
}

Console.WriteLine(sum())
Console.WriteLine(sum(42))`
        let output = CompileAndRun(source)
        Assert.Equal("0${Environment.NewLine}42${Environment.NewLine}", output)
    }

    @Fact
    func VariadicNullableReference_PacksNilAndRuns() {
        let source = `package P
import System

func count(values ...string?) int32 {
  return values.Length
}

Console.WriteLine(count(nil, "x"))`
        let output = CompileAndRun(source)
        Assert.Equal("2${Environment.NewLine}", output)
    }

    @Fact
    func VariadicWithFixedPrefix() {
        let source = `package P
import System

func sumWithBase(base int32, extras ...int32) int32 {
  var total = base
  for v in extras {
    total = total + v
  }
  return total
}

Console.WriteLine(sumWithBase(100, 1, 2, 3))`
        let output = CompileAndRun(source)
        Assert.Equal("106${Environment.NewLine}", output)
    }

    @Fact
    func VariadicWithOptionalFixedPrefix_AllowsOmission() {
        let source = `package P
import System

func describe(count int32 = 0, names ...string) string {
    return "$count:${names.Length}"
}

Console.WriteLine(describe())
Console.WriteLine(describe(count: 3))`
        let output = CompileAndRun(source)
        Assert.Equal("0:0${Environment.NewLine}3:0${Environment.NewLine}", output)
    }

    @Fact
    func SharedVariadicWithOptionalFixedPrefix_AllowsOmission() {
        let source = `package P
import System

class Formatter {
    shared {
        public func Describe(count int32 = 0, names ...string) string {
            return "$count:${names.Length}"
        }
    }
}

Console.WriteLine(Formatter.Describe())
Console.WriteLine(Formatter.Describe(count: 3))`
        let output = CompileAndRun(source)
        Assert.Equal("0:0${Environment.NewLine}3:0${Environment.NewLine}", output)
    }

    @Fact
    func InstanceVariadicWithOptionalFixedPrefix_AllowsOmission() {
        let source = `package P
import System

class Formatter {
    func Describe(count int32 = 0, names ...string) string {
        return "$count:${names.Length}"
    }
}

let formatter = Formatter()
Console.WriteLine(formatter.Describe())
Console.WriteLine(formatter.Describe(count: 3))`
        let output = CompileAndRun(source)
        Assert.Equal("0:0${Environment.NewLine}3:0${Environment.NewLine}", output)
    }

    // ADR-0101 / issue #799: generic variadic — mirrors `Sequences.Of`.
    @Fact
    func Variadic_Generic_PacksMultipleArgs() {
        let source = `package P
import System

func Of[T](values ...T) []T {
  return values
}

let xs = Of(1, 2, 3, 4)
Console.WriteLine(xs.Length)
Console.WriteLine(xs[0])
Console.WriteLine(xs[3])`
        let output = CompileAndRun(source)
        Assert.Equal("4${Environment.NewLine}1${Environment.NewLine}4${Environment.NewLine}", output)
    }

    @Fact
    func Variadic_Generic_SingleArrayPassesThrough() {
        // The pass-through path returns the same array the caller supplied —
        // a subsequent mutation to the original array is visible through the
        // returned slice. This test pins that identity guarantee in emitted
        // execution.
        let source = `package P
import System

func Of[T](values ...T) []T {
  return values
}

let arr = []int32{10, 20, 30}
let xs = Of(arr)
Console.WriteLine(xs.Length)
Console.WriteLine(xs[1])`
        let output = CompileAndRun(source)
        Assert.Equal("3${Environment.NewLine}20${Environment.NewLine}", output)
    }

    @Fact
    func Variadic_Generic_EmptyCall() {
        let source = `package P
import System

func Of[T](values ...T) []T {
  return values
}

let xs = Of[int32]()
Console.WriteLine(xs.Length)`
        let output = CompileAndRun(source)
        Assert.Equal("0${Environment.NewLine}", output)
    }

    // ADR-0101 / issue #799 — cross-language: a C# / F# consumer must see a
    // G#-authored variadic as a `params` method, which only works if the
    // emitted MethodDef carries [ParamArrayAttribute] on the last
    // parameter. We compile a G# library, then walk the emitted metadata
    // via Reflection to assert the attribute is present on the variadic
    // parameter (and only there), and invoke the method with an int[] to
    // confirm the IL accepts the C#-lowered call shape.
    @Fact
    func Variadic_Emits_ParamArrayAttribute_ForCSharpInterop() {
        let tempDir = Directory.CreateTempSubdirectory("gs_variadic_csinterop_").FullName
        try {
            let gsSrc = Path.Combine(tempDir, "lib.gs")
            let gsDll = Path.Combine(tempDir, "GsVariadicLib.dll")
            File.WriteAllText(gsSrc, `package GsVariadicLib

public func Sum(nums ...int32) int32 {
  var total = 0
  for v in nums {
    total = total + v
  }
  return total
}

public func SumWithBase(base int32, extras ...int32) int32 {
  var total = base
  for v in extras {
    total = total + v
  }
  return total
}

public func NoParams() int32 { return 42 }`)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(
                    []string{"/out:" + gsDll, "/target:library", "/targetframework:net10.0", gsSrc}
                )
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            IlVerifier.Verify(gsDll)
            let asm = EmittedFixture.Load(gsDll)
            let programType = asm.GetTypes().Single((t Type) -> t.Namespace == "GsVariadicLib" && t.Name == "<Program>")
            let sumMethod MethodInfo? = programType.GetMethod("Sum", BindingFlags.Public | BindingFlags.Static)
            Assert.NotNull(sumMethod)
            let sumParams = sumMethod!!.GetParameters()
            Assert.Single(sumParams)
            Assert.True(
                sumParams[0].GetCustomAttributesData().Any(
                    (a CustomAttributeData) -> a.AttributeType.FullName == "System.ParamArrayAttribute"
                ),
                "Single variadic parameter must carry [ParamArrayAttribute]."
            )
            // Mixed signature: only the trailing variadic gets the attribute.
            let mixed MethodInfo? = programType.GetMethod("SumWithBase", BindingFlags.Public | BindingFlags.Static)
            Assert.NotNull(mixed)
            let mixedParams = mixed!!.GetParameters()
            Assert.Equal(2, mixedParams.Length)
            Assert.False(
                mixedParams[0].GetCustomAttributesData().Any(
                    (a CustomAttributeData) -> a.AttributeType.FullName == "System.ParamArrayAttribute"
                ),
                "Fixed leading parameter must NOT carry [ParamArrayAttribute]."
            )
            Assert.True(
                mixedParams[1].GetCustomAttributesData().Any(
                    (a CustomAttributeData) -> a.AttributeType.FullName == "System.ParamArrayAttribute"
                ),
                "Trailing variadic parameter must carry [ParamArrayAttribute]."
            )
            // Non-variadic function: no [ParamArrayAttribute] anywhere.
            let noParams MethodInfo? = programType.GetMethod("NoParams", BindingFlags.Public | BindingFlags.Static)
            Assert.NotNull(noParams)
            Assert.Empty(noParams!!.GetParameters())
            // Invoke via reflection using the C#-style expanded array
            // (which is exactly what the C# compiler lowers a `params`
            // call to). The IL accepts the packed array as-is.
            let result object? = sumMethod!!.Invoke(nil, []object{[]int32{1, 2, 3, 4, 5}})
            Assert.Equal(15, result)
            let mixedResult object? = mixed!!.Invoke(nil, []object{100, []int32{1, 2, 3}})
            Assert.Equal(106, mixedResult)
            // Empty variadic call: caller supplies an empty array.
            let emptyResult object? = sumMethod!!.Invoke(nil, []object{Array.Empty[int32]()})
            Assert.Equal(0, emptyResult)
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    // ADR-0102 / issue #812 — variadic parameters on additional declaration
    // sites: class instance methods, class static (shared) methods,
    // interface DIM default bodies, constructors, lambdas, and named
    // delegates. Each site must emit a MethodDef whose trailing parameter
    // carries [ParamArrayAttribute] for C# interop.
    @Fact
    func Variadic_OnClassInstanceMethod_EndToEnd() {
        let source = `package P
import System

class Joiner {
  func Sum(nums ...int32) int32 {
    var total = 0
    for v in nums {
      total = total + v
    }
    return total
  }
}

var j = Joiner()
Console.WriteLine(j.Sum(1, 2, 3, 4, 5))
Console.WriteLine(j.Sum([]int32{10, 20, 30}))
Console.WriteLine(j.Sum())`
        let output = CompileAndRun(source)
        Assert.Equal("15${Environment.NewLine}60${Environment.NewLine}0${Environment.NewLine}", output)
    }

    @Fact
    func Variadic_OnSharedStaticMethod_EndToEnd() {
        let source = `package P
import System

class Sequences {
  shared {
    func Of[T](values ...T) []T { return values }
  }
}

let xs = Sequences.Of(1, 2, 3, 4)
Console.WriteLine(xs.Length)

let arr = []int32{10, 20, 30}
let ys = Sequences.Of(arr)
Console.WriteLine(ys.Length)
Console.WriteLine(ys[1])

let zs = Sequences.Of[int32]()
Console.WriteLine(zs.Length)`
        let output = CompileAndRun(source)
        Assert.Equal(
            "4${Environment.NewLine}3${Environment.NewLine}20${Environment.NewLine}0${Environment.NewLine}",
            output
        )
    }

    @Fact
    func Variadic_OnInterfaceDefaultBody_EndToEnd() {
        let source = `package P
import System

interface IAdder {
  func Add(nums ...int32) int32 {
    var total = 0
    for v in nums {
      total = total + v
    }
    return total
  }
}

class Adder : IAdder {}

var a = Adder()
Console.WriteLine(a.Add(1, 2, 3, 4))
Console.WriteLine(a.Add([]int32{5, 5}))
Console.WriteLine(a.Add())`
        let output = CompileAndRun(source)
        Assert.Equal("10${Environment.NewLine}10${Environment.NewLine}0${Environment.NewLine}", output)
    }

    @Fact
    func Variadic_OnConstructor_EndToEnd() {
        let source = `package P
import System

class Tags {
  var Values []string
  init(vs ...string) {
    Values = vs
  }
}

var t1 = Tags("a", "b", "c")
Console.WriteLine(t1.Values.Length)

var t2 = Tags([]string{"x", "y"})
Console.WriteLine(t2.Values.Length)

var t3 = Tags()
Console.WriteLine(t3.Values.Length)`
        let output = CompileAndRun(source)
        Assert.Equal("3${Environment.NewLine}2${Environment.NewLine}0${Environment.NewLine}", output)
    }

    @Fact
    func Variadic_OnLambda_EndToEnd() {
        // The lambda's FunctionTypeSymbol does not propagate IsVariadic to
        // call sites (ADR-0102 §5), so the caller passes an explicit []T.
        // The body still binds the parameter as `[]T` — exercised via
        // `xs.Length`. Both function-literal and arrow forms.
        let source = `package P
import System

let f = func(xs ...int32) int32 { return xs.Length }
Console.WriteLine(f([]int32{1, 2, 3}))

let g = (xs ...int32) -> xs.Length
Console.WriteLine(g([]int32{10, 20, 30, 40}))`
        let output = CompileAndRun(source)
        Assert.Equal("3${Environment.NewLine}4${Environment.NewLine}", output)
    }

    @Fact
    func Variadic_OnNamedDelegate_DirectAndInvoke_EndToEnd() {
        // `for v in xs` inside a function-literal body trips a known emit
        // issue (variable slot capture for the range variable); use the
        // C-style for loop instead.
        let source = `package P
import System

delegate Adder(nums ...int32) int32;

var d Adder = func(nums ...int32) int32 {
  var total = 0
  for var i = 0; i < nums.Length; i++ {
    total = total + nums[i]
  }
  return total
}

Console.WriteLine(d(1, 2, 3, 4))
Console.WriteLine(d.Invoke(5, 5))
Console.WriteLine(d([]int32{100, 200}))
Console.WriteLine(d())`
        let output = CompileAndRun(source)
        Assert.Equal(
            "10${Environment.NewLine}10${Environment.NewLine}300${Environment.NewLine}0${Environment.NewLine}",
            output
        )
    }

    // Cross-language: assert every new site emits [ParamArrayAttribute] on
    // the trailing variadic parameter so C# / F# consumers see `params`.
    // Split into two compilations because combining a DIM default-body
    // interface and a named delegate in the same compilation trips a
    // pre-existing emit bug (delegate .ctor MethodDef row mismatch) that
    // is out of scope for issue #812.
    @Fact
    func Variadic_AdditionalSites_Emit_ParamArrayAttribute_ForCSharpInterop() {
        let tempDir = Directory.CreateTempSubdirectory("gs_variadic_sites_csinterop_").FullName
        try {
            let gsSrc = Path.Combine(tempDir, "sites.gs")
            let gsDll = Path.Combine(tempDir, "GsVariadicSitesLib.dll")
            File.WriteAllText(gsSrc, `package GsVariadicSitesLib

public class Joiner {
  public func Sum(nums ...int32) int32 {
    var total = 0
    for var i = 0; i < nums.Length; i++ { total = total + nums[i] }
    return total
  }
}

public class Sequences {
  shared {
    public func Of[T](values ...T) []T { return values }
  }
}

public interface IAdder {
  func Add(nums ...int32) int32 {
    var total = 0
    for var i = 0; i < nums.Length; i++ { total = total + nums[i] }
    return total
  }
}

public class Tags {
  public var Values []string
  init(vs ...string) {
    Values = vs
  }
}`)
            CompileLibrary(gsSrc, gsDll)
            IlVerifier.Verify(gsDll)
            let asm = EmittedFixture.Load(gsDll)
            let flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance
            // (1) Class instance method.
            let joinerType = asm.GetTypes().Single((t Type) -> t.Name == "Joiner")
            let sumMethod MethodInfo? = joinerType.GetMethod("Sum", flags)
            Assert.NotNull(sumMethod)
            let sumParams = sumMethod!!.GetParameters()
            Assert.Single(sumParams)
            Assert.True(
                HasParamArray(sumParams[0]),
                "Class instance method's variadic param must carry [ParamArrayAttribute]."
            )
            // (2) Class static (shared) method.
            let sequencesType = asm.GetTypes().Single((t Type) -> t.Name == "Sequences")
            let ofMethod = sequencesType.GetMethods(flags).Single((m MethodInfo) -> m.Name == "Of")
            let ofParams = ofMethod.GetParameters()
            Assert.Single(ofParams)
            Assert.True(
                HasParamArray(ofParams[0]),
                "Class static (shared) method's variadic param must carry [ParamArrayAttribute]."
            )
            // (3) Interface DIM default body.
            let iadderType = asm.GetTypes().Single((t Type) -> t.Name == "IAdder")
            let addMethod MethodInfo? = iadderType.GetMethod("Add", flags)
            Assert.NotNull(addMethod)
            let addParams = addMethod!!.GetParameters()
            Assert.Single(addParams)
            Assert.True(
                HasParamArray(addParams[0]),
                "Interface DIM default body's variadic param must carry [ParamArrayAttribute]."
            )
            // (4) Constructor.
            let tagsType = asm.GetTypes().Single((t Type) -> t.Name == "Tags")
            let tagsCtor = tagsType.GetConstructors(flags).Single((c ConstructorInfo) -> c.GetParameters().Length == 1)
            let tagsCtorParams = tagsCtor.GetParameters()
            Assert.True(
                HasParamArray(tagsCtorParams[0]),
                "Constructor's variadic param must carry [ParamArrayAttribute]."
            )
            // Sanity: invoke the class instance method via reflection using
            // the C#-style expanded array (what `params` lowers to).
            let instance object? = Activator.CreateInstance(joinerType)
            let sumResult object? = sumMethod!!.Invoke(instance, []object{[]int32{1, 2, 3, 4, 5}})
            Assert.Equal(15, sumResult)
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    @Fact
    func Variadic_OnNamedDelegate_Emits_ParamArrayAttribute_OnInvoke() {
        // Standalone compilation — combining a DIM default-body interface
        // with a named delegate in the same compilation trips a pre-
        // existing emit bug (delegate .ctor MethodDef row mismatch). The
        // sites are exercised independently above.
        let tempDir = Directory.CreateTempSubdirectory("gs_variadic_delegate_csinterop_").FullName
        try {
            let gsSrc = Path.Combine(tempDir, "delegate.gs")
            let gsDll = Path.Combine(tempDir, "GsVariadicDelegateLib.dll")
            File.WriteAllText(gsSrc, `package GsVariadicDelegateLib

public delegate StringJoiner(sep string, parts ...string) string;`)
            CompileLibrary(gsSrc, gsDll)
            IlVerifier.Verify(gsDll)
            let asm = EmittedFixture.Load(gsDll)
            let stringJoinerType = asm.GetTypes().Single((t Type) -> t.Name == "StringJoiner")
            let invokeMethod MethodInfo? = stringJoinerType.GetMethod("Invoke")
            Assert.NotNull(invokeMethod)
            let invokeParams = invokeMethod!!.GetParameters()
            Assert.Equal(2, invokeParams.Length)
            Assert.False(
                HasParamArray(invokeParams[0]),
                "Named delegate's fixed leading param must NOT carry [ParamArrayAttribute]."
            )
            Assert.True(
                HasParamArray(invokeParams[1]),
                "Named delegate's trailing variadic param must carry [ParamArrayAttribute]."
            )
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    shared {
        private func CompileLibrary(gsSrc string, gsDll string) {
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(
                    []string{"/out:" + gsDll, "/target:library", "/targetframework:net10.0", gsSrc}
                )
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
        }

        private func HasParamArray(p ParameterInfo) bool -> p.GetCustomAttributesData().Any(
            (a CustomAttributeData) -> a.AttributeType.FullName == "System.ParamArrayAttribute"
        )

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_variadic_emit_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(
                        []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                    )
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                IlVerifier.Verify(outPath)
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
                psi.ArgumentList.Add(outPath)
                using let proc Process? = Process.Start(psi)
                let stdout = proc!!.StandardOutput.ReadToEnd()
                let stderr = proc!!.StandardError.ReadToEnd()
                Assert.True(proc!!.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc!!.ExitCode == 0, (`exited ` + "${proc!!.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
