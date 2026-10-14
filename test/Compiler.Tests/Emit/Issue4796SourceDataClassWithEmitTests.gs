// <copyright file="Issue4796SourceDataClassWithEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Linq
import System.Reflection
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.Emit
import Xunit
import Xunit.Abstractions
import SystemObject = System.Object
import GSharp.Compiler
import GSharp.Compiler.Tests
import System.Text

class Issue4796SourceDataClassWithEmitTests {
    private let output ITestOutputHelper

    init(output ITestOutputHelper) {
        this.output = output
    }

    @Theory
    @InlineData("plain", false, false)
    @InlineData("plain", true, true)
    @InlineData("generic", false, false)
    @InlineData("generic", true, true)
    @InlineData("nested", false, false)
    @InlineData("nested", true, true)
    @InlineData("derived", false, false)
    @InlineData("derived", true, true)
    func AuthoredOverloads_CopyPreservesStorageProvenanceAndLexicalEffects(
        shape string,
        property bool,
        overrides bool
    ) {
        let directory = Path.Combine(AppContext.BaseDirectory, "Issue4796-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let generic = shape == "generic" || shape == "nested"
            let valueType = if generic {
                "T"
            } else {
                "int"
            }
            let declaration = if shape == "generic" {
                "Row<T>"
            } else {
                "Row"
            }
            let owner = switch shape {
                case "generic": "Row<int>"
                case "nested": "Outer<int>.Row"
                default: "Row"
            }
            var record = (`public record ` + "$declaration" + `
{
    private readonly object owner;
    private readonly int initialized = Effects.Initialize();
    public string Field { get; }
    public bool Property { get; }
    public ` + "$valueType" + ` Value { get; init; }
    public bool IsDeclarationInitializer { get; init; }
    public Row(string field, ` + "$valueType" + ` value, object owner)
    {
        Field = field; Value = value; this.owner = owner; Effects.Construct();
    }
    public Row(bool property, ` + "$valueType" + ` value)
    {
        Property = property; Value = value; owner = new object(); Effects.Construct();
    }
    public object Owner() => owner;
    public int Initialized() => initialized;
}`)
            if shape == "nested" {
                record = "public class Outer<T> { " + record + `public static Row Create(string field, T value, object owner) =>
    new Row(field, value, owner) { IsDeclarationInitializer = true };
public static Row Create(bool property, T value) =>
    new Row(property, value) { IsDeclarationInitializer = true };
}`
            } else if shape == "derived" {
                record = `public record Parent
{
    private readonly object inherited = new object();
    public bool IsDeclarationInitializer { get; init; }
    public object Inherited() => inherited;
}` + record.Replace("public record Row", "public record Row : Parent", StringComparison.Ordinal).Replace(
                    "public bool IsDeclarationInitializer { get; init; }",
                    string.Empty,
                    StringComparison.Ordinal
                )
            }
            let arguments = if property {
                "true, 7"
            } else {
                "\"field\", 7, new object()"
            }
            let creation = if shape == "nested" {
                "Outer<int>.Create($arguments)"
            } else {
                "new $owner($arguments) { IsDeclarationInitializer = true }"
            }
            let source = (`using System;
using System.Collections.Immutable;
namespace SourceClone4796;
public static class Effects
{
    public static string Trace = "";
    public static int Initializations;
    public static int Constructors;
    public static int Initialize() { Trace += "I"; return ++Initializations; }
    public static void Construct() { Trace += "C"; Constructors++; }
    public static T Receiver<T>(T value) { Trace += "R"; return value; }
    public static bool Flag() { Trace += "F"; return false; }
    public static int Next() { Trace += "V"; return 9; }
}
` + "$record" + `
public static class Driver
{
    public static ` + "$owner" + ` Copy(` + "$owner" + ` original)
    {
        var builder = ImmutableArray.CreateBuilder<` + "$owner" + `>();
        builder.Add(Effects.Receiver(original) with {
            ` + "${(if overrides { "IsDeclarationInitializer = Effects.Flag(), Value = Effects.Next()" } else { "" })}" + `
        });
        return builder[0];
    }
    public static string Run()
    {
        Effects.Trace = ""; Effects.Initializations = Effects.Constructors = 0;
        var original = ` + "$creation" + `;
        var updated = Copy(original);
        return $"{original.Value}/{updated.Value}/{original.IsDeclarationInitializer}/{updated.IsDeclarationInitializer}/{original.Field == updated.Field}/{original.Property == updated.Property}/{Object.ReferenceEquals(original.Owner(), updated.Owner())}/{original.Initialized() == updated.Initialized()}/{Object.ReferenceEquals(original, updated)}/{Effects.Initializations}/{Effects.Constructors}/{Effects.Trace}";
    }
}`)
            let references = RuntimeReferences()
            let tree = CSharpSyntaxTree.ParseText(
                source,
                CSharpParseOptions(LanguageVersion.Preview),
                "Fixture.cs",
                Encoding.UTF8
            )
            let native = CSharpCompilation.Create(
                "NativeSourceClone4796",
                []SyntaxTree{tree},
                references.Select((path string) -> MetadataReference.CreateFromFile(path)),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, deterministic: true)
            )
            let nativePath = Path.Combine(directory, "NativeSourceClone4796.dll")
            {
                using let imageStream = File.Create(nativePath)
                {
                    using let pdbStream = File.Create(Path.ChangeExtension(nativePath, ".pdb"))
                    let emitted = native.Emit(
                        imageStream,
                        pdbStream,
                        options: EmitOptions(debugInformationFormat: DebugInformationFormat.PortablePdb)
                    )
                    Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
                }
            }
            IlVerifier.Verify(nativePath)
            let model = native.GetSemanticModel(tree)
            let translated = GSharpPrinter.Print(
                CSharpToGSharpTranslator().TranslateDocument(
                    LoadedDocument("Fixture.cs", tree, model),
                    TranslationContext(native, model, "Fixture.cs")
                )
            )
            let sourcePath = Path.Combine(directory, "Fixture.gs")
            let image = Path.Combine(directory, "SourceClone4796.dll")
            File.WriteAllText(sourcePath, translated)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            try {
                Console.SetOut(stdout)
                Console.SetError(stderr)
                let exit = Program.Main(
                    []string{
                        "/target:library",
                        "/assemblyname:SourceClone4796",
                        "/out:" + image,
                        "/targetframework:net10.0"
                    }
                        .Concat(references.Select((path string) -> ("/reference:" + path)))
                        .Append(sourcePath)
                        .ToArray()
                )
                Assert.True(exit == 0, stdout.ToString() + stderr.ToString())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            IlVerifier.Verify(image)
            let assemblies = EmittedFixture.LoadTogether(nativePath, image)
            let expected = if overrides {
                "7/9/True/False/True/True/True/True/False/1/1/ICRFV"
            } else {
                "7/7/True/True/True/True/True/True/False/1/1/ICR"
            }
            let nativeResult string? = Run(assemblies[0])
            let result string? = Run(assemblies[1])
            this.output.WriteLine("Explicit Roslyn/native: " + nativeResult)
            this.output.WriteLine("Actual cs2gs/gsc/CLR: " + result)
            Assert.Equal(expected, nativeResult)
            Assert.Equal(expected, result)
            let copy MethodInfo? = assemblies[1].GetType("SourceClone4796.Driver", throwOnError: true)!!.GetMethod(
                "Copy"
            )
            let clone MethodInfo? = copy!!.ReturnType.GetMethod(
                "<Clone>$$",
                BindingFlags.Instance | BindingFlags.Public
            )
            Assert.Equal(copy!!.ReturnType, clone!!.ReturnType)
            Assert.Empty(clone!!.GetParameters())
            let fields = copy!!.ReturnType.GetFields(BindingFlags.Instance | BindingFlags.NonPublic)
            Assert.True(fields.Single((field FieldInfo) -> field.Name == "owner").IsInitOnly)
            Assert.True(fields.Single((field FieldInfo) -> field.Name == "initialized").IsInitOnly)
            if shape == "derived" {
                let row = copy!!.ReturnType
                let original = row.GetConstructor([]Type{typeof(string), typeof(int32), typeof(object)})!!.Invoke(
                    []object{"field", 7, SystemObject()}
                )
                let baseClone object? = row.BaseType!!.GetMethod("<Clone>$$")!!.Invoke(original, nil)
                Assert.Equal(row, baseClone!!.GetType())
                Assert.NotSame(original, baseClone)
                Assert.Same(
                    row.GetMethod("Inherited")!!.Invoke(original, nil),
                    row.GetMethod("Inherited")!!.Invoke(baseClone, nil)
                )
            }
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    shared {
        private func Run(assembly Assembly) string? -> cast[string](
            assembly.GetType("SourceClone4796.Driver", throwOnError: true)!!.GetMethod("Run")!!.Invoke(nil, nil)
        )

        private func RuntimeReferences()[]string -> Directory.GetFiles(
            Path.GetDirectoryName(typeof(object).Assembly.Location)!!,
            "*.dll"
        )
    }
}
