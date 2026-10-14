// <copyright file="Issue4216ReceiverAttributeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import System.Diagnostics.CodeAnalysis
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import Xunit
import GSharp.Core.CodeAnalysis
import System
import System.Collections.Generic

/// Issue #4216: an annotation on an extension receiver is emitted on parameter
/// zero of the lowered static extension method.
open class Issue4216ReceiverAttributeEmitTests {
    @Fact
    func NotNullWhen_OnExtensionReceiver_RoundTripsThroughReflection() {
        const source = `package Issue4216
import System.Diagnostics.CodeAnalysis

func (@NotNullWhen(false) value string?) IsMissing4216() bool {
    return value == nil
}`
        let assembly = CompileToAssembly(source)
        let method = assembly
            .GetTypes()
            .SelectMany(
            func (type Type) IEnumerable[MethodInfo] {
                return type.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)
            }
        )
            .Single((candidate MethodInfo) -> candidate.Name == "IsMissing4216")
        let receiver = Assert.Single(method.GetParameters())
        let attribute = Assert.Single(receiver.GetCustomAttributes[NotNullWhenAttribute]())
        Assert.False(attribute.ReturnValue)
    }

    shared {
        private func CompileToAssembly(source string) Assembly {
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
            let loadContext = AssemblyLoadContext("Issue4216ReceiverAttributeEmitTests", isCollectible: true)
            return loadContext.LoadFromStream(peStream)
        }
    }
}
