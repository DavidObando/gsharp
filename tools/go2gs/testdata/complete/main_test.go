package fixture

import "testing"

func TestUse(t *testing.T) {
	if Use() != 5 {
		t.Fatal("unexpected result")
	}
}
