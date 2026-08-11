// <copyright file="Issue3334ImportedPackageFunctionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

public sealed class Issue3334ImportedPackageFunctionTests
{
    [Fact]
    public void ImportedPackage_PublicFunction_FromReferencedAssembly_Runs()
    {
        var outputDirectory = Path.Combine(AppContext.BaseDirectory, "Issue3334", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(outputDirectory);
        try
        {
            var libraryPath = Path.Combine(outputDirectory, "FindingCrossAssemblyPackageFunction.dll");
            var library = new Compilation(
                SyntaxTree.Parse(SourceText.From(
                    """
                    package FindingCrossAssemblyPackageFunction

                    public func Answer() int32 {
                      return 42
                    }
                    """)))
            {
                IsLibrary = true,
            };

            using (var output = File.Create(libraryPath))
            {
                var emit = library.Emit(
                    output,
                    pdbStream: null,
                    refStream: null,
                    assemblyName: "FindingCrossAssemblyPackageFunction");
                Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics));
            }

            var result = EmittedOracle.Evaluate(
                """
                package FindingCrossAssemblyPackageFunctionApp

                import FindingCrossAssemblyPackageFunction

                func Main() int32 {
                  return Answer() == 42 ? 0 : 1
                }
                """,
                new[] { libraryPath });

            Assert.Empty(result.Diagnostics);
            Assert.Equal(0, result.ExitCode);
            Assert.Equal(0, Assert.IsType<int>(result.Value));
        }
        finally
        {
            Directory.Delete(outputDirectory, recursive: true);
        }
    }
}
