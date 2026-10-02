#!/bin/bash
docker exec -i beebeebio-postgres-1 psql -U beebeeb -d beebeeb -At "$@"
