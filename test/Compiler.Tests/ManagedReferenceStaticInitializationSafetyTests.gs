// <copyright file="ManagedReferenceStaticInitializationSafetyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import Gsharp.Values
import System
import System.IO
import System.Reflection
import Xunit

class ManagedReferenceStaticInitializationSafetyTests {
    @Theory
    @InlineData("class Bad { shared { prop Value managed[int32] { get; set; } } }")
    @InlineData("struct Bad { shared { prop Value readonly managed[int32] { get; set; } } }")
    @InlineData("class Bad { shared { var Value managed[int32] } }")
    @InlineData("struct Bad[T] { shared { var Value readonly managed[T] } }")
    @InlineData("struct Wrapper { var Value managed[int32] }\nclass Bad { shared { var Value Wrapper } }")
    func StaticAutoPropertyStorageRequiresInitialization(declaration string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(
            "package StaticManagedReferenceReject\n" + declaration,
            "StaticManagedReferenceReject",
            executable: false
        )
        Assert.NotEqual(0, code)
        Assert.Contains("error GS0604:", output, StringComparison.Ordinal)
    }

    @Fact
    func StaticInitializerMustAssignRequiredStorageOnEveryPath() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(`package StaticManagedReferencePathReject
class Bad {
    shared {
        var Value managed[int32]
        init {
            if DateTime.Now.Ticks > 0 {
                var local = 1
                Value = managed(local)
            }
        }
    }
}`, "StaticManagedReferencePathReject", executable: false)
        Assert.NotEqual(0, code)
        Assert.Contains("error GS0604:", output, StringComparison.Ordinal)
    }

    @Fact
    func InitializedStaticFieldsPropertiesAndNullableControlsReimportAndVerify() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "StaticManagedReferenceApi.ref.dll")
        let api = fixture.Compile(`package StaticManagedReferenceApi
public class Holder[T] {
    shared {
        public var Field readonly managed[T]
        public prop Property readonly managed[T] { get; set; }
        public var Optional managed[T]?
        public prop OptionalProperty readonly managed[T]? { get; set; }
        init {
            var first T = default
            Field = readonly managed(first)
            var second T = default
            Property = readonly managed(second)
        }
    }
}`, "StaticManagedReferenceApi", executable: false, "/refout:" + reference)
        IlVerifier.Verify(api)
        let consumer = fixture.CompileCSharp(`using StaticManagedReferenceApi;
public static class Consumer {
    public static int Run() {
        ref readonly var field = ref Holder<int>.Field.Borrow();
        ref readonly var property = ref Holder<int>.Property.Borrow();
        return field + property
            + (Holder<int>.Optional is null ? 20 : 0)
            + (Holder<int>.OptionalProperty is null ? 22 : 0);
    }
}`, "StaticManagedReferenceConsumer", api, reference)
        IlVerifier.Verify(consumer, []string{api})
        let assemblies = EmittedFixture.LoadTogether(api, consumer)
        Assert.Equal(42, assemblies[1].GetType("Consumer")!!.GetMethod("Run")!!.Invoke(nil, nil))
    }

    @Fact
    func StaticRequiredInitializationSurvivesRepeatedEmitAndRefout() {
        const source = `package RepeatedStaticManagedReference
public struct Holder {
    shared {
        public var Field managed[int32] = {
            var value = 42
            managed(value)
        }
    }
}`
        using let references = ReferenceResolver.WithRuntimeReferences(
            []string{typeof(ManagedRef[_]).Assembly.Location}
        )
        let compilation = Compilation(references, SyntaxTree.Parse(source)){IsLibrary = true}
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        for var i = 0; i < 2; i++ {
            using let pe = MemoryStream()
            using let reference = MemoryStream()
            let result = compilation.Emit(pe, nil, reference)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            Assert.True(pe.Length > int64(0))
            Assert.True(reference.Length > int64(0))
        }
    }
}
