// <copyright file="Issue2331AsyncCaptureHoistFieldTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #2331 (deferred half): proves at the synthesized-type level that an
/// outer local referenced only inside a nested lambda after an <c>await</c>
/// is hoisted into the async state machine, while a local declared and used
/// only inside the lambda's own body is not.
/// </summary>
public class Issue2331AsyncCaptureHoistFieldTests
{
    [Fact]
    public void AsyncMethod_OuterLocalUsedOnlyInLambda_IsHoisted_LambdaOwnLocal_IsNot()
    {
        const string Source = """
            package SmHoistFieldTest
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
            Console.WriteLine(t.Result)
            """;

        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(Source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);
        Assert.True(result.Success, "Compilation failed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(nameof(AsyncMethod_OuterLocalUsedOnlyInLambda_IsHoisted_LambdaOwnLocal_IsNot), isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);
            var smType = asm.GetTypes().FirstOrDefault(t => t.Name.Contains("<run>d__"));
            Assert.NotNull(smType);

            var fieldNames = smType!.GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
                .Select(f => f.Name)
                .ToArray();

            // `x` is referenced only inside the nested lambda `f`, after the
            // `await` — it must still be hoisted as a state-machine field.
            Assert.Contains(fieldNames, n => n.Contains("x"));

            // `ownLocal` is declared and used only inside `f`'s own body; it
            // belongs to the lambda's separately-lowered function and must
            // never appear as a field on the *outer* `run` state machine.
            Assert.DoesNotContain(fieldNames, n => n.Contains("ownLocal"));
        }
        finally
        {
            loadContext.Unload();
        }
    }
}
