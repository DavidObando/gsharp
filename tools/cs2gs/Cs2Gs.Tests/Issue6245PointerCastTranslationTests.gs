// <copyright file="Issue6245PointerCastTranslationTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Runtime.Loader
import Xunit

/// Issue #6245: explicit C# pointer and function-pointer conversions must
/// render with G#'s unambiguous `cast[*T](expr)` / `cast[fnptr](expr)` syntax
/// rather than `*T(expr)`, which parses as a unary dereference of `T(expr)`
/// and fails with GS0128 (`(int*)0` -> `*int32(0)`). Dereference and `->`
/// member access on such casts must parenthesize the cast so `gsc` does not
/// reinterpret `*cast[*T](p)` as a double-pointer cast.
open class Issue6245PointerCastTranslationTests {
    @Fact
    func ExplicitPointerCasts_ZeroLiteralAndPrimitives_UseCastIntrinsicAndMatchCSharpRuntime() {
        let printed = AssertRunsLikeCSharp(`
#nullable enable
using System;
namespace Demo
{
    public static unsafe class P
    {
        public static int* Pointer() => (int*)0;

        public static byte* FromByte(byte n) => (byte*)n;

        public static void* ToVoid(int* p) => (void*)p;

        public static int** DoublePtr(void* p) => (int**)p;

        public static int* NullPtr() => (int*)null;

        public static string Run()
        {
            int* zero = Pointer();
            byte* fromByte = FromByte(7);
            void* asVoid = ToVoid(fromByte != null ? (int*)12 : zero);
            int** dbl = DoublePtr(asVoid);
            int* nilPtr = NullPtr();
            return (zero == null) + "|" + ((nint)fromByte) + "|" + ((nint)asVoid) + "|" + ((nint)dbl) + "|" + (nilPtr == null);
        }
    }
}
`, "True|7|12|12|True", allowUnsafeIl: true)
        Assert.Contains("cast[*int32](0)", printed, StringComparison.Ordinal)
        Assert.Contains("cast[*uint8](n)", printed, StringComparison.Ordinal)
        Assert.Contains("cast[*void](p)", printed, StringComparison.Ordinal)
        Assert.Contains("cast[**int32](p)", printed, StringComparison.Ordinal)
        Assert.Contains("cast[*int32](nil)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("*int32(", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("*uint8(", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("*void(", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("**int32(", printed, StringComparison.Ordinal)
    }

    @Fact
    func ExplicitPointerCasts_MemberAccessDereferenceAndFunctionPointers_MatchCSharpRuntime() {
        let printed = AssertRunsLikeCSharp(`
#nullable enable
using System;
namespace Demo
{
    public unsafe struct Node
    {
        public int Value;
        public void* Next;

        public int Doubled() => Value * 2;
    }

    public static unsafe class P
    {
        private static int AddTen(int x) => x + 10;

        public static int* CastMemberResult(Node* ptr) => (int*)ptr->Next;

        public static int ReadAndWriteViaCast(void* raw)
        {
            ((Node*)raw)->Value = 21;
            int sum = ((Node*)raw)->Doubled();
            int* pVal = &((Node*)raw)->Value;
            *(int*)pVal = *(int*)pVal + 4;
            return sum + ((Node*)raw)->Value;
        }

        public static string Run()
        {
            var n = new Node { Value = 1, Next = (void*)99 };
            int* nextPtr = CastMemberResult(&n);
            int combined = ReadAndWriteViaCast(&n);
            delegate*<int, int> fp = &AddTen;
            void* erasedFp = (void*)fp;
            var restoredFp = (delegate*<int, int>)erasedFp;
            var unmanagedZero = (delegate* unmanaged[Cdecl]<int, int>)0;
            return ((nint)nextPtr) + "|" + combined + "|" + restoredFp(5) + "|" + (unmanagedZero == null);
        }
    }
}
`, "99|67|15|True", allowUnsafeIl: true)
        Assert.Contains("cast[*int32](ptr->Next)", printed, StringComparison.Ordinal)
        Assert.Contains("(cast[*Node](raw))->Value = 21", printed, StringComparison.Ordinal)
        Assert.Contains("(cast[*Node](raw))->Doubled()", printed, StringComparison.Ordinal)
        Assert.Contains("*(cast[*int32](pVal))", printed, StringComparison.Ordinal)
        Assert.Contains("cast[*func(int32) int32](erasedFp)", printed, StringComparison.Ordinal)
        Assert.Contains("cast[unmanaged[Cdecl] (int32) -> int32](0)", printed, StringComparison.Ordinal)
    }

    @Fact
    func NumericAndReferenceCasts_RetainCanonicalForms_NegativeControls() {
        let printed = AssertRunsLikeCSharp(`
#nullable enable
using System;
namespace Demo
{
    public static class P
    {
        public static string Run()
        {
            long wide = 42L;
            int narrow = (int)wide;
            object boxed = "hello";
            string text = (string)boxed;
            return narrow + "|" + text;
        }
    }
}
`, "42|hello")
        Assert.Contains("int32(wide)", printed, StringComparison.Ordinal)
        Assert.Contains("cast[string](boxed)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("cast[int32](wide)", printed, StringComparison.Ordinal)
    }

    shared {
        private func AssertRunsLikeCSharp(source string, expectedOutput string, allowUnsafeIl bool = false) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            using let peStream = MemoryStream()
            let emitted = project.Compilation.Emit(peStream)
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
            let loadContext = AssemblyLoadContext("Issue6245", isCollectible: true)
            var expected string
            try {
                peStream.Position = 0
                expected = cast[string](
                    loadContext.LoadFromStream(peStream).GetType("Demo.P", throwOnError: true)!!.GetMethod(
                        "Run"
                    )!!.Invoke(nil, nil)
                )
            } finally {
                loadContext.Unload()
            }
            Assert.Equal(expectedOutput, expected)

            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
            let printed = GSharpPrinter.Print(unit)
            let roundTrip RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                roundTrip!!.Success,
                "Translated G# must bind cleanly. Errors:\n" + string.Join("\n", roundTrip!!.Errors) +
                    "\n\nPrinted:\n" +
                    printed
            )
            CompileVerifyAndRun(printed, "System.Console.WriteLine(P.Run())", expected, allowUnsafeIl)
            return printed
        }

        private func CompileVerifyAndRun(
            printed string,
            callExpression string,
            expectedOutput string,
            allowUnsafeIl bool
        ) {
            let compiler string? = LocalFunctionHoistTranslationTests.FindCompiler()
            Assert.True(compiler != nil, "gsc.dll must be built before running this test.")
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-6245-e2e", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(workDir)
            try {
                let gsPath = Path.Combine(workDir, "Snippet.gs")
                let dllPath = Path.Combine(workDir, "Snippet.dll")
                File.WriteAllText(gsPath, printed + Environment.NewLine + callExpression + Environment.NewLine)
                let compile = ProcessRunner.Run(
                    "dotnet",
                    []string{compiler!!, "/target:exe", "/out:$dllPath", gsPath},
                    timeout: TimeSpan.FromSeconds(60)
                )
                Assert.False(compile.TimedOut, "gsc timed out:\n" + compile.Output)
                Assert.True(
                    compile.ExitCode == 0 && !compile.Output.Contains("error", StringComparison.OrdinalIgnoreCase),
                    "gsc must compile the translated snippet. Output:\n" +
                        compile.Output +
                        "\n\nTranslated G#:\n" +
                        printed
                )
                Assert.True(
                    !compile.Output.Contains("GS0536", StringComparison.Ordinal),
                    "gsc must not report redundant assertions. Output:\n" +
                        compile.Output +
                        "\n\nTranslated G#:\n" +
                        printed
                )

                let repoRoot = GsharpTestProjectRunner.FindRepoRootAbove(AppContext.BaseDirectory) ??
                    GsharpTestProjectRunner.FindRepoRoot()
                if repoRoot != nil {
                    let runner = IlVerifyRunner(repoRoot)
                    let verify = runner.Verify(dllPath)
                    if !allowUnsafeIl &&
                        verify.Status != IlVerifyStatus.Skipped &&
                        verify.Status != IlVerifyStatus.Unavailable {
                        Assert.True(
                            verify.Status == IlVerifyStatus.Passed,
                            "ILVerify must pass. Output:\n" + verify.Output + "\n\nTranslated G#:\n" + printed
                        )
                    } else if allowUnsafeIl && verify.Status == IlVerifyStatus.Failed {
                        let unexpected = verify
                            .Errors
                            .Where(
                            (e IlVerifyError) -> !(e.Code is "UnmanagedPointer" or "StackUnexpected" or "StackByRef")
                        )
                            .ToList()
                        Assert.True(
                            unexpected.Count == 0,
                            "Unexpected ILVerify errors beyond known unsafe-pointer codes:\n" + string.Join(
                                "\n",
                                unexpected.Select((e IlVerifyError) -> e.RawLine)
                            )
                        )
                    }
                }

                let run = ProcessRunner.Run("dotnet", []string{dllPath}, timeout: TimeSpan.FromSeconds(60))
                Assert.False(run.TimedOut, "Translated program timed out:\n" + run.Output)
                Assert.True(run.ExitCode == 0, "Translated program must exit 0. Output:\n" + run.Output)
                Assert.Equal(expectedOutput + Environment.NewLine, run.Stdout)
            } finally {
                try {
                    Directory.Delete(workDir, recursive: true)
                } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
        }
    }
}
