// <copyright file="Issue2331AsyncCaptureHoistFieldTests.cs" company="GSharp">
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

/// Issue #2331 (deferred half): proves at the synthesized-type level that an
/// outer local referenced only inside a nested lambda after an `await`
/// is hoisted into the async state machine, while a local declared and used
/// only inside the lambda's own body is not.
open class Issue2331AsyncCaptureHoistFieldTests {
    @Fact
    func AsyncMethod_OuterLocalUsedOnlyInLambda_IsHoisted_LambdaOwnLocal_IsNot() {
        const Source = `package SmHoistFieldTest
import System
import System.Threading.Tasks

async func run() int32 {
    let x = 10
    await Task.CompletedTask
    let f = () -> {
        let ownLocal = 5
        return x + ownLocal
    }
    return f()
}

var t = run()
t.Wait()
Console.WriteLine(t.Result)`
        using let peStream = MemoryStream()
        let tree = SyntaxTree.Parse(SourceText.From(Source))
        let compilation = Compilation(tree)
        let result = compilation.Emit(peStream)
        Assert.True(
            result.Success,
            "Compilation failed: " + string.Join("; ", result.Diagnostics.Select((d Diagnostic) -> d.Message))
        )
        peStream.Position = 0
        let loadContext = AssemblyLoadContext(
            "AsyncMethod_OuterLocalUsedOnlyInLambda_IsHoisted_LambdaOwnLocal_IsNot",
            isCollectible: true
        )
        try {
            let asm = loadContext.LoadFromStream(peStream)
            let smType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name.Contains("<run>d__"))
            Assert.NotNull(smType)
            let fieldNames = smType!!
                .GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
                .Select((f FieldInfo) -> f.Name)
                .ToArray()
            // `x` is referenced only inside the nested lambda `f`, after the
            // `await` — it must still be hoisted as a state-machine field.
            Assert.Contains(fieldNames, (n string) -> n.Contains("x"))
            // `ownLocal` is declared and used only inside `f`'s own body; it
            // belongs to the lambda's separately-lowered function and must
            // never appear as a field on the *outer* `run` state machine.
            Assert.DoesNotContain(fieldNames, (n string) -> n.Contains("ownLocal"))
        } finally {
            loadContext.Unload()
        }
    }
}
