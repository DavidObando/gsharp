// <copyright file="Issue2164LazySingletonNullForgivenessTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Immutable
import System.Linq
import Xunit

/// Translator-fidelity tests for issue #2164: the classic lazy-singleton pattern
/// initializes a nullable static/instance field (or auto-property) under a null
/// guard (`if (F == null) { F = new(); } ... return F;` / `F ??= …;`),
/// so `F` is provably non-null at every use dominated by the guard. gsc (by
/// design, Kotlin-style smart casts) narrows only LOCALS, never fields/properties,
/// so the guarded read `T? -> T` is rejected (GS0155). The migrated corpus
/// is nullable-<em>oblivious</em>, so Roslyn's flow state is empty; cs2gs detects
/// the guard from SYNTAX and emits the established `F!!` non-null assertion
/// on the guarded use instead.
open class Issue2164LazySingletonNullForgivenessTranslationTests {
    @Fact
    func LazySingleton_StaticField_EqualsNullGuard_AssertsNonNullReturn() {
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Service
    {
        private static Service instance;

        public static Service Instance
        {
            get
            {
                if (instance == null)
                {
                    instance = new Service();
                }

                return instance;
            }
        }
    }
}`)
        Assert.Contains("private var instance Service?", printed)
        Assert.Contains("return instance!!", printed)
    }

    @Fact
    func LazySingleton_StaticField_IsNullGuard_AssertsNonNullReturn() {
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Service
    {
        private static Service instance;

        public static Service Instance
        {
            get
            {
                if (instance is null)
                {
                    instance = new Service();
                }

                return instance;
            }
        }
    }
}`)
        Assert.Contains("return instance!!", printed)
    }

    @Fact
    func LazySingleton_CoalesceAssign_AssertsNonNullReturn() {
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Service
    {
        private static Service instance;

        public static Service Instance
        {
            get
            {
                instance ??= new Service();
                return instance;
            }
        }
    }
}`)
        Assert.Contains("!!", printed)
        Assert.Contains("return instance!!", printed)
    }

    @Fact
    func LazySingleton_LockWrappedGuard_AssertsNonNullReturn() {
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Singleton<T> where T : class, new()
    {
        private static readonly object Lockable = new object();
        private static T instance;

        public static T Instance
        {
            get
            {
                lock (Lockable)
                {
                    if (instance is null)
                    {
                        instance = new T();
                    }

                    return instance;
                }
            }
        }
    }
}`)
        Assert.Contains("private var instance T?", printed)
        Assert.Contains("return instance!!", printed)
    }

    @Fact
    func LazySingleton_GuardedMemberAccess_AssertsNonNullReceiver() {
        // A use of `instance` dominated by the guard that is NOT a trailing
        // `return` (here `instance.ToString()`) is asserted too.
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Service
    {
        private static Service instance;

        public static string Name
        {
            get
            {
                if (instance == null)
                {
                    instance = new Service();
                }

                return instance.ToString();
            }
        }
    }
}`)
        Assert.Contains("instance!!.ToString()", printed)
    }

    @Fact
    func NonNullableField_NoGuard_IsNotAsserted() {
        // A field that is never null-checked / null-assigned is not nullable in
        // G#, so no `!!` must be emitted on its return.
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Service
    {
        private static readonly Service instance = new Service();

        public static Service Instance
        {
            get
            {
                return instance;
            }
        }
    }
}`)
        Assert.DoesNotContain("!!", printed)
    }

    shared {
        private func TranslateOblivious(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions)
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            return PrintAndValidate(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }

        private func PrintAndValidate(unit CompilationUnit) string {
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }
    }
}
