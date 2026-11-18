package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import System.Text.RegularExpressions
import Xunit

class Issue6090SharedMethodGroupDriverTests : IClassFixture[Issue6090MethodGroupLibrary] {
    private let fixture Issue6090MethodGroupLibrary

    init(fixture Issue6090MethodGroupLibrary) {
        this.fixture = fixture
    }

    @Theory
    @InlineData("Configure", "(input, root)", "")
    @InlineData("GridHooks.Configure", "(input Input, root Root)", "void")
    @InlineData("callback", "(input, root)", "void")
    func ForwardingLambda_DoesNotChangeMethodGroupIdentity(group string, parameters string, result string) {
        let local = if group == "callback" {
            "let callback Action[Input, Root]? = Configure\n"
        } else {
            ""
        }
        fixture.Check(`import Fixture
import System
internal class GridHooks {
    shared {
        internal var Calls int32
        internal func Configure(input Input, root Root) RESULT {
            Calls++
            root.Width += 7
        }
        internal func Create() Input {
            LOCALreturn Input{ConfigureRoot: GROUP}
        }
    }
}
func Build() Input -> Input{
    ConfigureRoot: PARAMETERS -> GridHooks.Configure(input, root)
}
let direct = GridHooks.Create()
let forwarded = Build()
let root = Root{Width: 3}
let callback = direct.ConfigureRoot!!
Console.Write(callback.Method.Name)
Console.Write("|")
Console.Write(callback.Target == nil)
Console.Write("|")
Console.Write(callback.Method.DeclaringType == typeof(GridHooks))
Console.Write("|")
callback(direct, root)
Console.Write(root.Width)
Console.Write("|")
forwarded.ConfigureRoot!!(forwarded, root)
Console.Write(root.Width)
Console.Write("|")
Console.Write(GridHooks.Calls)
`.Replace(
                "RESULT",
                result
            ).Replace(
                "LOCAL",
                local
            ).Replace("GROUP", group).Replace("PARAMETERS", parameters), "Configure|True|True|10|17|2")
    }

    @Theory
    @InlineData("input Input", "root int32")
    @InlineData("input Root", "root Root")
    @InlineData("input Input", "root Root, extra int32")
    func IncompatibleMethodGroups_RemainLocatedErrors(first string, rest string) {
        let source = `import Fixture
internal class GridHooks {
    shared {
        internal func Configure(FIRST, REST) {}
        internal func Create() Input -> Input{ConfigureRoot: Configure}
    }
}
func Build() Input -> Input{
    ConfigureRoot: (input, root) -> {}
}
GridHooks.Create()
`.Replace("FIRST", first).Replace("REST", rest)
        let result = fixture.Compile(source)
        Assert.Equal(1, result.Code)
        let error = Assert.Single(
            Regex.Matches(
                Encoding.UTF8.GetString(result.Bytes) + result.Error,
                `\((\d+),(\d+),(\d+),(\d+)\): error (GS\d+):`
            )
                .Cast[Match]()
        )
        Assert.Equal(
            "5,62,5,71,GS0218",
            string.Join(",", error.Groups.Cast[Group]().Skip(1).Select((g Group) -> g.Value))
        )
    }
}

class Issue6090MethodGroupLibrary : IDisposable {
    private let directory string
    private let library string

    init() {
        directory = Path.Combine(AppContext.BaseDirectory, "issue6090-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        library = Path.Combine(directory, "Fixture.dll")
        let source = Path.Combine(directory, "Library.gs")
        File.WriteAllText(source, `package Fixture
import System
public class Root { public var Width int32 }
public data struct Input { var ConfigureRoot Action[Input, Root]? }
`)
        let built = Run(
            []string{
                typeof(Program).Assembly.Location,
                source,
                "/target:library",
                "/targetframework:net10.0",
                "/out:" + library
            }
        )
        Assert.True(built.Code == 0, Encoding.UTF8.GetString(built.Bytes) + built.Error)
    }

    public func Dispose() -> Directory.Delete(directory, recursive: true)

    func Compile(source string)(Code int32, Bytes[]uint8, Error string) {
        let input = Path.Combine(directory, "Consumer.gs")
        let image = Path.Combine(directory, "Consumer.dll")
        File.Delete(image)
        File.WriteAllText(input, source)
        return Run(
            []string{
                typeof(Program).Assembly.Location,
                input,
                "/target:exe",
                "/targetframework:net10.0",
                "/reference:" + library,
                "/out:" + image
            }
        )
    }

    func Check(source string, expected string) {
        let compiled = Compile(source)
        Assert.True(compiled.Code == 0, Encoding.UTF8.GetString(compiled.Bytes) + compiled.Error)
        let executed = Run([]string{Path.Combine(directory, "Consumer.dll")})
        Assert.True(executed.Code == 0, Encoding.UTF8.GetString(executed.Bytes) + executed.Error)
        Assert.Empty(executed.Error)
        Assert.Equal(Encoding.UTF8.GetBytes(expected), executed.Bytes)
    }

    private func Run(arguments IEnumerable[string])(Code int32, Bytes[]uint8, Error string) {
        let start = ProcessStartInfo("dotnet"){
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        }
        for argument in arguments {
            start.ArgumentList.Add(argument)
        }
        using let process = Process.Start(start) ?? throw InvalidOperationException("Could not start dotnet.")
        using let bytes = MemoryStream()
        let stdout = process.StandardOutput.BaseStream.CopyToAsync(bytes)
        let stderr = process.StandardError.ReadToEndAsync()
        let exited = process.WaitForExit(30_000)
        if !exited {
            process.Kill(entireProcessTree: true)
        }
        process.WaitForExit()
        stdout.GetAwaiter().GetResult()
        Assert.True(exited, "Shared method-group driver exceeded 30 seconds.")
        return (process.ExitCode, bytes.ToArray(), stderr.GetAwaiter().GetResult())
    }
}
