using System;
using System.Diagnostics;
using System.IO;
using System.Linq;

namespace GSharp.VisualStudio;

internal static class DotnetHostResolver
{
    private const int RequiredMajorVersion = 10;
    internal const string MissingRuntimeMessage =
        "The G# language server requires Microsoft.NETCore.App 10.0 or newer. " +
        "Install the .NET 10 Runtime from https://dotnet.microsoft.com/download/dotnet/10.0 " +
        "or set DOTNET_ROOT to a compatible installation.";

    public static string Resolve()
    {
        string? fromRoot = ResolveFromRoot(Environment.GetEnvironmentVariable("DOTNET_ROOT"));
        if (fromRoot != null && SupportsRequiredRuntime(fromRoot))
        {
            return fromRoot;
        }

        if (SupportsRequiredRuntime("dotnet"))
        {
            return "dotnet";
        }

        string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        string? installed = ResolveFromRoot(Path.Combine(programFiles, "dotnet"));
        if (installed != null && SupportsRequiredRuntime(installed))
        {
            return installed;
        }

        throw new InvalidOperationException(MissingRuntimeMessage);
    }

    internal static bool HasRequiredRuntime(string output)
        => output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
            .Select(line => line.Trim())
            .Where(line => line.StartsWith("Microsoft.NETCore.App ", StringComparison.Ordinal))
            .Select(line => line.Substring("Microsoft.NETCore.App ".Length).Split(' ')[0])
            .Select(version => Version.TryParse(version, out Version? parsed) ? parsed : null)
            .Any(version => version != null && version.Major >= RequiredMajorVersion);

    private static string? ResolveFromRoot(string? root)
    {
        if (string.IsNullOrWhiteSpace(root))
        {
            return null;
        }

        string path = Path.Combine(root, "dotnet.exe");
        return File.Exists(path) ? path : null;
    }

    private static bool SupportsRequiredRuntime(string dotnetPath)
    {
        try
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = dotnetPath,
                Arguments = "--list-runtimes",
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
            };
            using (var process = Process.Start(startInfo))
            {
                if (process == null)
                {
                    return false;
                }

                string output = process.StandardOutput.ReadToEnd();
                process.WaitForExit(5000);
                return process.HasExited && process.ExitCode == 0 && HasRequiredRuntime(output);
            }
        }
        catch (Exception e) when (e is InvalidOperationException || e is System.ComponentModel.Win32Exception)
        {
            return false;
        }
    }
}
