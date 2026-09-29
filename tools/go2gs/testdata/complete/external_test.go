package fixture_test

import (
	"testing"

	fixture "example.com/go2gsfixture"
)

func TestExternal(t *testing.T) {
	if fixture.Use() != 5 {
		t.Fatal("unexpected result")
	}
}
