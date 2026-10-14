// <copyright file="Issue3334ImportedPackageFunctionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.IO
import Xunit

class Issue3334ImportedPackageFunctionTests {
    @Fact
    func ImportedPackage_PublicFunction_FromReferencedAssembly_Runs() {
        let outputDirectory = Path.Combine(AppContext.BaseDirectory, "Issue3334", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(outputDirectory)
        try {
            let libraryPath = Path.Combine(outputDirectory, "FindingCrossAssemblyPackageFunction.dll")
            let library = Compilation(SyntaxTree.Parse(SourceText.From(`package FindingCrossAssemblyPackageFunction

public func Answer() int32 {
  return 42
}`))){IsLibrary = true}
            {
                using let output = File.Create(libraryPath)
                let emit = library.Emit(
                    output,
                    pdbStream: nil,
                    refStream: nil,
                    assemblyName: "FindingCrossAssemblyPackageFunction"
                )
                Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
            }
            let result = EmittedOracle.Evaluate(`package FindingCrossAssemblyPackageFunctionApp

import FindingCrossAssemblyPackageFunction

func Main() int32 {
  return Answer() == 42 ? 0 : 1
}`, []string{libraryPath})
            Assert.Empty(result.Diagnostics)
            Assert.Equal(0, result.ExitCode)
            Assert.Equal(0, Assert.IsType[int32](result.Value))
        } finally {
            Directory.Delete(outputDirectory, recursive: true)
        }
    }
}
