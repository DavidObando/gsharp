// <copyright file="Issue5273GenericCallbackInferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import System
import System.Linq
import Xunit

class Issue5273GenericCallbackInferenceTests {
    @Theory
    @InlineData("DispatchProbe().Read()")
    @InlineData("Free(CALLBACK)")
    @InlineData("DispatchProbe().Invoke(CALLBACK)")
    @InlineData("DispatchProbe.StaticInvoke(CALLBACK)")
    @InlineData("int32(0).InvokeExtension(CALLBACK)")
    func NestedGenericLambdaReturnKeepsItsTypeAndRunsOnce(invocation string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let call = invocation.Replace(
            "CALLBACK",
            "() -> Task.FromResult(Uri(DispatchProbe.Next()))",
            StringComparison.Ordinal
        )
        let reader = if invocation == "DispatchProbe().Read()" {
            `public func Read() Task[Uri] {
        let result = Main(() -> Task.FromResult(Uri(DispatchProbe.Next())))
        return result
    }`
        } else {
            string.Empty
        }
        let source = (`package Callback5273
import System
import System.Threading.Tasks
func Free[T](call Func[T]) T -> call()
func (self int32) InvokeExtension[T](call Func[T]) T -> call()
class DispatchProbe {
    private func Main[T](call Func[T]) T -> call()
    ` + reader + `
    public func Invoke[T](call Func[T]) T -> call()
    shared {
        public var Calls int32 = 0
        public func Next() string {
            Calls += 1
            return "content://org.goo.probe/document"
        }
        public func StaticInvoke[T](call Func[T]) T -> call()
    }
}
func Main() {
    let result = ` + call + `
    let typed Task[Uri] = result
    Console.WriteLine(typed.Result.AbsoluteUri)
    Console.WriteLine(DispatchProbe.Calls)
}`)
        let references = ReferenceClosure.RefPackAssemblies().Select((path string) -> "/r:" + path).ToArray()
        let dll = fixture.Compile(source, "Callback5273", true, references)
        IlVerifier.Verify(dll)
        Assert.Equal("content://org.goo.probe/document\n1\n", fixture.Run(dll))
    }

    @Fact
    func NamedDelegateInfersThroughItsNestedReturnSignature() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.CompileCSharp(`using System;
namespace Contracts5273;
public delegate Tuple<T> Factory<T>(int value);`, "Contracts5273")
        let references = ReferenceClosure
            .RefPackAssemblies()
            .Select((path string) -> "/r:" + path)
            .Append("/r:" + library)
            .ToArray()
        let dll = fixture.Compile(`package NamedCallback5273
import System
import Contracts5273
func Create[T](factory Factory[T]) T -> factory(42).Item1
func Main() {
    let result = Create((value int32) -> Tuple.Create(Uri("content://org.goo.probe/" + value.ToString())))
    let typed Uri = result
    Console.WriteLine(typed.AbsoluteUri)
}`, "NamedCallback5273", true, references)
        IlVerifier.Verify(dll, []string{library})
        Assert.Equal("content://org.goo.probe/42\n", fixture.Run(dll))
    }
}
