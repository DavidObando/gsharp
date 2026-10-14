// <copyright file="Issue2642NullableInheritedImportedPropertyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import Xunit

class Issue2642NullableInheritedImportedPropertyTests {
    @Fact
    func OahuSettings_NullConditionalFindsImportedBaseProperty() {
        let result = CompileConsumer(`package Issue2642.App
import Issue2642.Ref

class OahuUserSettings : UserSettingsBase { }

class CoreEnvironment {
    shared {
        var settings OahuUserSettings?
        func Read() string? -> CoreEnvironment.settings?.DownloadSettings
    }
}`, "OahuSettings_NullConditionalFindsImportedBaseProperty")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    @Fact
    func UnknownPropertyThroughNullConditional_StillReportsGS0158() {
        let result = CompileConsumer(`package Issue2642.App
import Issue2642.Ref

class OahuUserSettings : UserSettingsBase { }

class CoreEnvironment {
    shared {
        var settings OahuUserSettings?
        func Read() string? -> CoreEnvironment.settings?.NotDownloadSettings
    }
}`, "UnknownPropertyThroughNullConditional_StillReportsGS0158")
        Assert.Single(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0158")
    }

    shared {
        private const LibrarySource string = `package Issue2642.Ref

open class UserSettingsBase {
    prop DownloadSettings string {
        get -> "2642"
    }
}`

        private func CompileConsumer(source string, caseName string) EmitResult {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue2642", caseName)
            Directory.CreateDirectory(directory)
            let libraryPath = Path.Combine(directory, "Issue2642.Ref.dll")
            let library = Compilation(SyntaxTree.Parse(SourceText.From(LibrarySource))){IsLibrary = true}
            {
                using let stream = File.Create(libraryPath)
                let result = library.Emit(stream, pdbStream: nil, refStream: nil, assemblyName: "Issue2642.Ref")
                Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            }
            using let references = ReferenceResolver.WithReferences([]string{libraryPath})
            references.CurrentAssemblyName = "Issue2642.App"
            let consumer = Compilation(references, SyntaxTree.Parse(SourceText.From(source))){IsLibrary = true}
            using let output = MemoryStream()
            return consumer.Emit(output, pdbStream: nil, refStream: nil, assemblyName: "Issue2642.App")
        }
    }
}
