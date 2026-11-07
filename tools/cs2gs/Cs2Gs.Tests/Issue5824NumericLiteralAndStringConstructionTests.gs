// Copyright (C) GSharp Authors. All rights reserved.

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

open class Issue5824NumericLiteralTranslationTests {
    @Theory
    @InlineData("argument")
    @InlineData("return")
    @InlineData("array")
    @InlineData("collection")
    @InlineData("conditional")
    @InlineData("default")
    func IntegerLiterals_PreserveNumericDestinationAndRuntimeOutput(position string) {
        let source = StringBuilder("using System; using System.Collections.Generic; public class P {")
        let main = StringBuilder("public static void Main() {")
        let literals = []string{
            "1",
            "-1",
            "+1",
            "0",
            "1L",
            "-1L",
            "+1L",
            "0L",
            "0xAE",
            "0b1010",
            "1_000",
            "1 + 2",
            "((1))",
            "16777217",
            "9007199791611905L",
            "9223372036854775807L",
            "long.MinValue"
        }
        let types = []string{"float", "float?", "double", "decimal"}
        for var typeIndex = 0; typeIndex < types.Length; typeIndex++ {
            let type = types[typeIndex]
            let typeTag = typeIndex.ToString()
            let suffix = if type == "decimal" {
                "m"
            } else if type == "double" {
                "d"
            } else {
                "f"
            }
            if position == "array" || position == "collection" {
                let container = if position == "array" {
                    type + "[]"
                } else {
                    "List<" + type + ">"
                }
                source.Append(
                    "static " + container + " Values" + typeTag + "() => new " + container + " { " + string.Join(
                        ", ",
                        literals
                    ) +
                        " };"
                )
                main.Append("foreach (var value in Values" + typeTag + "()) Console.WriteLine(value);")
                continue
            }
            if position == "argument" {
                source.Append("static " + type + " F" + typeTag + "(" + type + " value) => value;")
            }
            for var literalIndex = 0; literalIndex < literals.Length; literalIndex++ {
                let name = "R${typeIndex}_${literalIndex}"
                let literal = literals[literalIndex]
                if position == "default" {
                    source.Append("static " + type + " " + name + "(" + type + " value = " + literal + ") => value;")
                } else {
                    let expression = if position == "argument" {
                        "F" + typeTag + "(" + literal + ")"
                    } else if position == "conditional" {
                        "choose ? " + literal + " : 2" + suffix
                    } else {
                        literal
                    }
                    let parameters = if position == "conditional" {
                        "bool choose"
                    } else {
                        ""
                    }
                    source.Append("static " + type + " " + name + "(" + parameters + ") => " + expression + ";")
                }
                if position == "conditional" {
                    main.Append("Console.WriteLine(" + name + "(true)); Console.WriteLine(" + name + "(false));")
                } else {
                    main.Append("Console.WriteLine(" + name + "());")
                }
            }
        }
        source.Append(main.ToString() + "} }")
        LiteralConstructionRuntimeParity.AssertMatches(source.ToString())
    }
}

open class Issue5826StringConstructionTranslationTests {
    @Fact
    func KeywordAliasedConstructors_PreserveClrIdentity() {
        LiteralConstructionRuntimeParity.AssertMatches(`
using System;
public class P
{
    static int Object() => 7;
    static int String(char value, int count) => 6;
    static int IntPtr(long value) => 8;
    static int UIntPtr(ulong value) => 9;
    public static void Main()
    {
        Console.WriteLine(new object().GetType().FullName);
        Console.WriteLine(new string('k', 3));
        Console.WriteLine(new nint(1L).GetType().FullName);
        Console.WriteLine(new nuint(2UL).GetType().FullName);
    }
}`)
    }

    @Theory
    @InlineData("class", "method")
    @InlineData("struct", "method")
    @InlineData("class", "matching-method")
    @InlineData("struct", "matching-method")
    @InlineData("class", "property")
    @InlineData("struct", "property")
    @InlineData("class", "field")
    @InlineData("struct", "field")
    @InlineData("class", "local")
    @InlineData("struct", "local")
    @InlineData("class", "parameter")
    @InlineData("struct", "parameter")
    @InlineData("class", "type")
    @InlineData("class", "alias-local")
    @InlineData("class", "namespace-local")
    @InlineData("class", "namespace-type")
    @InlineData("class", "namespace-alias")
    @InlineData("class", "reused-alias")
    func StringConstructors_DoNotBindToVisibleHomonyms(owner string, shadow string) {
        let declaration = switch shadow {
            case "method": "static bool String(IComparable? value) => value is not null;"
            case "matching-method": "static string String(char[] value) => \"method\"; " +
                "static string String(char value, int count) => \"method\";"
            case "property": "static int String => 7;"
            case "field": "static int String = 7;"
            case "type": "public class String { public static int Value => 7; }"
            case "reused-alias": "static int Text => 7; static int String = 5;"
            case "namespace-type": "public class System { } static int String = 5;"
            case "namespace-alias": "static int String = 5;"
            default: ""
        }
        let parameters = if shadow == "parameter" {
            "int String"
        } else {
            ""
        }
        let argument = if shadow == "parameter" {
            "7"
        } else {
            ""
        }
        let local = switch shadow {
            case "local": "int String = 7;"
            case "alias-local": "int String = 5; int SystemString = 7;"
            case "namespace-local": "int String = 5; int System = 7;"
            default: ""
        }
        let prefix = switch shadow {
            case "method": "String(new string(new[] { 'k', 'e', 'y' })).ToString()"
            case "matching-method": "String(new[] { 'x' })"
            case "type": "String.Value.ToString()"
            case "alias-local": "SystemString.ToString()"
            case "namespace-local": "System.ToString()"
            case "reused-alias": "Text.ToString()"
            default: "String.ToString()"
        }
        let imports = switch shadow {
            case "reused-alias": "using Text = System.String;"
            case "namespace-alias": "using System = ShadowSystem; public class ShadowSystem { }"
            default: ""
        }
        let source = "using System; " +
            imports +
            " public " +
            owner +
            " P { " +
            declaration +
            " public static string Run(" +
            parameters +
            ") { " +
            local +
            " return " +
            prefix +
            " + \":\" + new string(new[] { 'k', 'e', 'y' }) + \":\" + " +
            "new string('!', 3) + \":\" + Make(); } " +
            "static string Make() => new('?', 2); }" +
            " public class Program { public static void Main() { global::System.Console.WriteLine(P.Run(" +
            argument +
            ")); } }"
        LiteralConstructionRuntimeParity.AssertMatches(source)
    }
}

internal shared class LiteralConstructionRuntimeParity {
    func AssertMatches(source string) {
        let tree = CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest), path: "Probe.cs")
        let compilation = CSharpCompilation.Create(
            "Native",
            []SyntaxTree{tree},
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.ConsoleApplication).WithNullableContextOptions(
                NullableContextOptions.Enable
            )
        )
        Assert.Empty(
            compilation.GetDiagnostics().Where(
                (diagnostic Diagnostic) ->
                diagnostic.Severity == DiagnosticSeverity.Error
            )
        )
        let model = compilation.GetSemanticModel(tree)
        let context = TranslationContext(compilation, model, "Probe.cs")
        let printed = GSharpPrinter.Print(
            CSharpToGSharpTranslator().TranslateDocument(LoadedDocument("Probe.cs", tree, model), context)
        )
        let directory = Path.Combine(
            AppContext.BaseDirectory,
            "literal-construction-parity",
            Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(directory)
        try {
            let nativePath = Path.Combine(directory, "Native.dll")
            {
                using let stream = File.Create(nativePath)
                let result = compilation.Emit(stream)
                Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            }
            File.WriteAllText(
                Path.Combine(directory, "Native.runtimeconfig.json"),
                `{"runtimeOptions":{"tfm":"net10.0","framework":{"name":"Microsoft.NETCore.App","version":"10.0.0"}}}`
            )
            let expected = RunDotnet([]string{nativePath})
            Assert.NotEmpty(expected)
            let gsPath = Path.Combine(directory, "Translated.gs")
            let translatedPath = Path.Combine(directory, "Translated.dll")
            File.WriteAllText(gsPath, printed)
            RunDotnet(
                []string{FindCompiler(), "/target:exe", "/targetframework:net10.0", "/out:" + translatedPath, gsPath},
                printed
            )
            Assert.Equal(expected, RunDotnet([]string{translatedPath}))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    private func RunDotnet(arguments[]string, printed string = "") string {
        let start = ProcessStartInfo("dotnet"){
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        }
        for argument in arguments {
            start.ArgumentList.Add(argument)
        }
        using let process = Process.Start(start) ?? throw InvalidOperationException("Could not start dotnet.")
        let stdout = process.StandardOutput.ReadToEndAsync()
        let stderr = process.StandardError.ReadToEndAsync()
        if !process.WaitForExit(120000) {
            process.Kill(entireProcessTree: true)
            process.WaitForExit()
            Assert.Fail("dotnet process timed out.")
        }
        let output = stdout.GetAwaiter().GetResult()
        let errors = stderr.GetAwaiter().GetResult()
        Assert.True(process.ExitCode == 0, "dotnet failed:\n" + output + errors + "\n" + printed)
        return output
    }

    private func FindCompiler() string {
        var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
        while directory != nil {
            let candidate = Path.Combine(directory.FullName, "out", "bin", "Release", "Compiler", "gsc.dll")
            if File.Exists(candidate) {
                return candidate
            }
            directory = directory.Parent
        }
        throw FileNotFoundException("Build gsc before running runtime parity tests.")
    }
}
