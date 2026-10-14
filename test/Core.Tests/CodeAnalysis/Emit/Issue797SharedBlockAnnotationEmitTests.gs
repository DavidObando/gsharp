// <copyright file="Issue797SharedBlockAnnotationEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #797: end-to-end emit verification that a Kotlin-style annotation
/// on a static method declared inside a `shared { … }` block
/// (ADR-0053) survives the parser → binder → emitter pipeline and lands as
/// a real `CustomAttribute` row on the emitted MethodDef.
open class Issue797SharedBlockAnnotationEmitTests {
    @Fact
    func AnnotationOnSharedStaticMethod_IsEmittedOnMethodDef() {
        const Source = `package Issue797.SharedAttrEmit

import System

class Sequences {
    shared {
        @Obsolete("issue-797 marker")
        func Range(start int32, count int32) int32 {
            return start + count
        }
    }
}
`
        let asm = CompileToAssembly(Source, "Issue797.SharedAttrEmit")
        let seqType = asm.GetTypes().Single((t Type) -> t.Name == "Sequences")
        let range_ MethodInfo? = seqType.GetMethod(
            "Range",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance
        )
        Assert.NotNull(range_)
        Assert.True(range_!!.IsStatic, "Range should be emitted as a static method (shared { } block).")
        let obsolete ObsoleteAttribute? = range_!!
            .GetCustomAttributes(typeof(ObsoleteAttribute), inherit: false)
            .Cast[ObsoleteAttribute]()
            .SingleOrDefault()
        Assert.NotNull(obsolete)
        Assert.Equal("issue-797 marker", obsolete!!.Message)
    }

    shared {
        private func CompileToAssembly(source string, contextName string) Assembly {
            using let peStream = MemoryStream()
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            peStream.Position = 0
            let loadContext = AssemblyLoadContext(contextName, isCollectible: false)
            return loadContext.LoadFromStream(peStream)
        }
    }
}
