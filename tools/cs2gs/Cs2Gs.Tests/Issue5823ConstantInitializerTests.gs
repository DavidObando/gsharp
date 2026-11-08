// <copyright file="Issue5823ConstantInitializerTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import GCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSourceText = GSharp.Core.CodeAnalysis.Text.SourceText
import GSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import System
import System.IO
import Xunit

class Issue5823ConstantInitializerTests {
    @Fact
    func DecimalMetadataConstants_TranslateCompileAndRunLikeCSharp() {
        let printed = Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
namespace Demo {
    public static class P {
        const decimal Max = decimal.MaxValue;
        const decimal Min = decimal.MinValue;
        const decimal Zero = decimal.Zero;
        const decimal One = decimal.One;
        const decimal MinusOne = decimal.MinusOne;
        public static string Run() {
            const decimal Local = Max;
            return (Local == decimal.MaxValue) + " " + (Min == decimal.MinValue) + " " +
                (Zero == 0m) + " " + (One == 1m) + " " + (MinusOne == -1m);
        }
    }
}`, "True True True True True")
        Verify(printed)
    }

    @Fact
    func ReferenceNullConstants_TranslateCompileAndRunLikeCSharp() {
        let printed = Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
namespace Demo {
    public class C {}
    public interface I {}
    public delegate void D();
    public static class P {
        const C? Nil = null;
        const C? DefaultNil = default;
        const I? InterfaceNil = null;
        const D? DelegateNil = null;
        const C[]? ArrayNil = null;
        const object? ObjectNil = null;
        const string? StringNil = default;
        public static string Run() {
            const C? Local = Nil;
            const C? LocalDefault = default;
            return (Local == null) + " " + (LocalDefault == null) + " " + (DefaultNil == null) + " " +
                (InterfaceNil == null) + " " + (DelegateNil == null) + " " + (ArrayNil == null) + " " +
                (ObjectNil == null) + " " + (StringNil == null);
        }
    }
}`, "True True True True True True True True")
        Verify(printed)
    }

    shared {
        private func Verify(printed string) {
            let directory = Path.Combine(AppContext.BaseDirectory, "constant-ilverify-" + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            try {
                let path = Path.Combine(directory, "translated.dll")
                using let references = ReferenceResolver.WithReferences([]string{})
                let compilation = GCompilation(references, []GSyntaxTree{GSyntaxTree.Parse(GSourceText.From(printed))})
                compilation.IsLibrary = true
                using let stream = MemoryStream()
                let result = compilation.Emit(stream, pdbStream: nil, refStream: nil, assemblyName: "translated")
                Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
                File.WriteAllBytes(path, stream.ToArray())
                let verification = IlVerifyRunner().Verify(path, []string{})
                Assert.True(verification.Status == IlVerifyStatus.Passed, verification.Output)
                Assert.Empty(verification.Errors)
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }
    }
}
