// <copyright file="DocumentUriTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Runtime.InteropServices;
using GSharp.LanguageServer.Protocol;
using Xunit;

namespace GSharp.LanguageServer.Tests;

public class DocumentUriTests
{
    [Fact]
    public void GetFileSystemPath_FileUri_ReturnsPath()
    {
        // file:///path/to/file.gs is valid on both platforms
        var uri = DocumentUri.From("file:///path/to/file.gs");
        var path = uri.GetFileSystemPath();

        Assert.NotNull(path);
        Assert.Contains("file.gs", path);
    }

    [Fact]
    public void GetFileSystemPath_NonFileUri_ReturnsRawUri()
    {
        var uri = DocumentUri.From("untitled:Untitled-1");
        Assert.Equal("untitled:Untitled-1", uri.GetFileSystemPath());
    }

    [Fact]
    public void GetFileSystemPath_Null_ReturnsNull()
    {
        var uri = DocumentUri.From("");
        Assert.Null(uri.GetFileSystemPath());
    }

    [Theory]
    [InlineData("file:///c%3A/Users/foo/bar.gs")]
    [InlineData("file:///C%3A/Users/foo/bar.gs")]
    [InlineData("file:///c:/Users/foo/bar.gs")]
    [InlineData("file:///C:/Users/foo/bar.gs")]
    public void GetFileSystemPath_WindowsDriveLetter_StripsLeadingSlash(string rawUri)
    {
        var uri = DocumentUri.From(rawUri);
        var path = uri.GetFileSystemPath();

        // On all platforms, the result must NOT start with '/' when a drive
        // letter follows. Without the fix, %3A-encoded URIs produced
        // "/c:/Users/..." which Windows turned into the bogus "C:\c:\...".
        Assert.NotNull(path);
        Assert.False(path.StartsWith("/"), $"Path should not start with '/': {path}");
        Assert.True(char.IsLetter(path[0]), $"Path should start with a drive letter: {path}");
    }

    [Fact]
    public void GetFileSystemPath_PercentEncodedColon_RoundTrips_OnWindows()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return;
        }

        // VS Code commonly sends "file:///c%3A/..." on Windows.
        var uri = DocumentUri.From("file:///c%3A/Users/foo/bar.gs");
        var path = uri.GetFileSystemPath();

        // Must be a valid rooted Windows path that Path.GetFullPath won't mangle.
        var full = System.IO.Path.GetFullPath(path);
        Assert.DoesNotContain(@"c:\c:", full, System.StringComparison.OrdinalIgnoreCase);
        Assert.EndsWith("bar.gs", full);
    }

    [Fact]
    public void FromFileSystemPath_RoundTrips()
    {
        // This tests the opposite direction: path → URI → path
        var original = RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
            ? @"C:\Users\foo\bar.gs"
            : "/home/foo/bar.gs";
        var uri = DocumentUri.FromFileSystemPath(original);
        var roundTripped = uri.GetFileSystemPath();

        Assert.Equal(
            System.IO.Path.GetFullPath(original),
            System.IO.Path.GetFullPath(roundTripped));
    }
}
