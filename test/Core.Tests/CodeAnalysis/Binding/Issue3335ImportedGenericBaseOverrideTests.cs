// <copyright file="Issue3335ImportedGenericBaseOverrideTests.cs" company="GSharp">
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

public sealed class Issue3335ImportedGenericBaseOverrideTests
{
    [Fact]
    public void ConsumerTypeArgument_SubstitutesImportedOverrideParameterAndReturn_Runs()
    {
        var outputDirectory = Path.Combine(AppContext.BaseDirectory, "Issue3335", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(outputDirectory);
        try
        {
            var libraryPath = Path.Combine(outputDirectory, "FindingCrossAssemblyGenericOverride.dll");
            var library = new Compilation(
                SyntaxTree.Parse(SourceText.From(
                    """
                    package FindingCrossAssemblyGenericOverride

                    public open class Converter[T] {
                      public open func Read(item T, data []float64);
                      public open func Write(data []float64) T;
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
                    assemblyName: "FindingCrossAssemblyGenericOverride");
                Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics));
            }

            var result = EmittedOracle.Evaluate(
                """
                package FindingCrossAssemblyGenericOverrideApp

                import FindingCrossAssemblyGenericOverride

                public class Payload {
                  public var Value float64
                }

                public class PayloadConverter : Converter[Payload] {
                  public override func Read(item Payload, data []float64) {
                    item.Value = data[0]
                  }

                  public override func Write(data []float64) Payload {
                    return Payload{ Value: data[0] }
                  }
                }

                func Main() int32 {
                  let converter Converter[Payload] = PayloadConverter()
                  let payload = converter.Write([]float64{ 1.5 })
                  converter.Read(payload, []float64{ 2.5 })
                  return payload.Value == 2.5 ? 0 : 1
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
