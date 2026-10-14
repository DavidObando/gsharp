// <copyright file="Issue2810ExplicitLambdaParameterConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Runtime.InteropServices
import Xunit

class Issue2810ExplicitLambdaParameterConversionTests {
    @Fact
    func TargetValue_ExplicitIntParameter_IsRejected() {
        let diagnostics = Bind((`import System.Collections.Generic
import System.Linq

` + "$Declarations" + `

func Test(nums List[Value]) {
    nums.Where((x int32) -> x % 2 == 0)
}`))
        Assert.Contains(diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0155")
    }

    @Fact
    func TargetIntClass_ExplicitIntParameter_UsesImplicitConversion() {
        let diagnostics = Bind((`import System.Collections.Generic
import System.Linq

` + "$Declarations" + `

func Test(nums List[Int]) {
    nums.Where((x int32) -> x % 2 == 0)
}`))
        Assert.DoesNotContain(diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
    }

    @Fact
    func TargetInt_ExplicitClassParameter_UsesImplicitConversion() {
        let diagnostics = Bind((`import System.Collections.Generic
import System.Linq

` + "$Declarations" + `

func Test(nums List[int32]) {
    nums.ForEach((x Wrapped) -> x.Get())
}`))
        Assert.DoesNotContain(diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
    }

    @Fact
    func TargetValue_UntypedParameter_RemainsTargetTyped() {
        let diagnostics = Bind((`import System.Collections.Generic
import System.Linq

` + "$Declarations" + `

func Test(nums List[Value]) {
    nums.Where(x -> x.Get() % 2 == 0)
}`))
        Assert.DoesNotContain(diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
    }

    @Fact
    func TargetObject_ExplicitUserParameter_RequiresCheckedCast() {
        let diagnostics = Bind((`import System.Collections.Generic

` + "$Declarations" + `

func Test(values List[object]) {
    values.ForEach((x Wrapped) -> x.Get())
}`))
        Assert.Contains(diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0156")
    }

    @Fact
    func NullableTarget_ExplicitNonNullableParameter_RemainsRuntimeCompatible() {
        let diagnostics = Bind(`import System.Collections.Generic

func Test(values List[string?]) {
    values.ForEach((x string) -> x.Length)
}`)
        Assert.DoesNotContain(diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
    }

    shared {
        private const Declarations string = `interface Value {
    func Get() int32;
}

class Int(val int32) : Value {
    func Get() int32 {
        return val
    }

    func operator implicit(value Int) int32 {
        return value.Get()
    }
}

class Wrapped(val int32) {
    func Get() int32 {
        return val
    }

    func operator implicit(value int32) Wrapped {
        return Wrapped(value)
    }
}`

        private func Bind(source string) ImmutableArray[Diagnostic] {
            using let references = ReferenceResolver.WithReferences(
                Directory.EnumerateFiles(
                    RuntimeEnvironment.GetRuntimeDirectory(),
                    "*.dll",
                    SearchOption.TopDirectoryOnly
                )
            )
            let compilation = Compilation(references, SyntaxTree.Parse(SourceText.From(source)))
            return compilation
                .SyntaxTrees
                .SelectMany(
                func (tree SyntaxTree) IEnumerable[Diagnostic] {
                    return tree.Diagnostics
                }
            )
                .Concat(compilation.GlobalScope.Diagnostics)
                .Concat(compilation.BoundProgram.Diagnostics)
                .ToImmutableArray()
        }
    }
}
