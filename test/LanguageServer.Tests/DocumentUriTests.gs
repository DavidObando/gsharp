// <copyright file="DocumentUriTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.LanguageServer.Protocol
import System
import System.IO
import System.Runtime.InteropServices
import Xunit

open class DocumentUriTests {
    @Fact
    func GetFileSystemPath_FileUri_ReturnsPath() {
        // file:///path/to/file.gs is valid on both platforms
        let uri = DocumentUri.From("file:///path/to/file.gs")!!
        let path = uri.GetFileSystemPath()
        Assert.NotNull(path)
        Assert.Contains("file.gs", path)
    }

    @Fact
    func GetFileSystemPath_NonFileUri_ReturnsRawUri() {
        let uri = DocumentUri.From("untitled:Untitled-1")!!
        Assert.Equal("untitled:Untitled-1", uri.GetFileSystemPath())
    }

    @Fact
    func GetFileSystemPath_Null_ReturnsNull() {
        let uri = DocumentUri.From("")!!
        Assert.Null(uri.GetFileSystemPath())
    }

    @Theory
    @InlineData("file:///c%3A/Users/foo/bar.gs")
    @InlineData("file:///C%3A/Users/foo/bar.gs")
    @InlineData("file:///c:/Users/foo/bar.gs")
    @InlineData("file:///C:/Users/foo/bar.gs")
    func GetFileSystemPath_WindowsDriveLetter_StripsLeadingSlash(rawUri string) {
        let uri = DocumentUri.From(rawUri)!!
        let path = uri.GetFileSystemPath()
        // On all platforms, the result must NOT start with '/' when a drive
        // letter follows. Without the fix, %3A-encoded URIs produced
        // "/c:/Users/..." which Windows turned into the bogus "C:\c:\...".
        Assert.NotNull(path)
        Assert.False(path!!.StartsWith("/"), "Path should not start with '/': $path")
        Assert.True(char.IsLetter(path!![0]), "Path should start with a drive letter: $path")
    }

    @Fact
    func GetFileSystemPath_PercentEncodedColon_RoundTrips_OnWindows() {
        if !RuntimeInformation.IsOSPlatform(OSPlatform.Windows) {
            return
        }
        // VS Code commonly sends "file:///c%3A/..." on Windows.
        let uri = DocumentUri.From("file:///c%3A/Users/foo/bar.gs")!!
        let path = uri.GetFileSystemPath()!!
        // Must be a valid rooted Windows path that Path.GetFullPath won't mangle.
        let full = Path.GetFullPath(path)
        Assert.DoesNotContain("c:\\c:", full, StringComparison.OrdinalIgnoreCase)
        Assert.EndsWith("bar.gs", full)
    }

    @Fact
    func FromFileSystemPath_RoundTrips() {
        // This tests the opposite direction: path → URI → path
        let original = if RuntimeInformation.IsOSPlatform(OSPlatform.Windows) {
            "C:\\Users\\foo\\bar.gs"
        } else {
            "/home/foo/bar.gs"
        }
        let uri = DocumentUri.FromFileSystemPath(original)!!
        let roundTripped = uri.GetFileSystemPath()!!
        Assert.Equal(Path.GetFullPath(original), Path.GetFullPath(roundTripped))
    }
}
